package scheduler

import (
	"bytes"
	"context"
	"hash/fnv"
	"log"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/madflojo/tasks"
	"github.com/openstatushq/openstatus/apps/checker/pkg/job"
	v1 "github.com/openstatushq/openstatus/apps/checker/proto/private_location/v1"
	"google.golang.org/protobuf/proto"
)

const (
	Interval10s = "10s"
	Interval30s = "30s"
	Interval1m  = "1m"
	Interval5m  = "5m"
	Interval10m = "10m"
	Interval30m = "30m"
	Interval1h  = "1h"
)

type MonitorManager struct {
	Client    v1.PrivateLocationServiceClient
	JobRunner job.JobRunner
	Scheduler *tasks.Scheduler
	mu        sync.Mutex
	configs   map[string][]byte
}

// shouldSchedule reports whether a task has to be created for the monitor, and
// drops the running one first when the config changed: a task captures its
// monitor when it is created, so an edited monitor would otherwise keep
// checking with the config it had on the probe's first fetch.
// startAfter spreads a monitor's checks across its own interval.
//
// Every monitor on the same periodicity would otherwise fire on the same tick,
// and a probe running twenty-odd of them starts that many TLS handshakes in the
// same millisecond. On a small box the crypto serialises and every check
// reports the queue as if it were the network: measured on a 1 vCPU probe,
// sequentially a check took 21ms and twenty-two at once took a median of 321ms.
// A one-minute load average shows 0.01 throughout, so nothing about the host
// looks busy — the latency is simply wrong, and wrong in the direction that
// makes a healthy service look slow.
//
// The offset is derived from the monitor id rather than random, so it is stable
// across restarts: a probe that reshuffled on every deploy would move every
// monitor's latency series for reasons that have nothing to do with the target.
//
// It is spread over a few seconds rather than over the whole interval. Spreading
// across the interval would delay a monitor's FIRST result by up to that
// interval — an hour, for an hourly check — which trades a latency artefact for
// a blank chart and a slow answer to "did the thing I just added work". A
// handshake costs on the order of 20ms of CPU, so a few seconds is already
// enough room for tens of monitors to take their turn without queueing.
const spreadWindow = 5 * time.Second

func startAfter(id string, interval time.Duration) time.Time {
	window := spreadWindow
	if interval > 0 && interval < window {
		window = interval
	}
	if window <= 0 {
		return time.Now()
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	offset := time.Duration(h.Sum32()%uint32(window/time.Millisecond)) * time.Millisecond
	return time.Now().Add(offset)
}

func (mm *MonitorManager) shouldSchedule(id string, monitor proto.Message) bool {
	mm.mu.Lock()
	defer mm.mu.Unlock()

	if mm.configs == nil {
		mm.configs = make(map[string][]byte)
	}

	config, err := proto.MarshalOptions{Deterministic: true}.Marshal(monitor)
	if err != nil {
		log.Printf("Failed to encode config for monitor %s: %v", id, err)
		config = nil
	}

	if _, lookupErr := mm.Scheduler.Lookup(id); lookupErr != nil {
		mm.configs[id] = config
		return true
	}

	if bytes.Equal(mm.configs[id], config) {
		return false
	}

	log.Printf("Config changed for monitor %s, rescheduling", id)
	mm.Scheduler.Del(id)
	mm.configs[id] = config
	return true
}

// UpdateMonitors fetches the latest monitors and starts/stops jobs as needed
func (mm *MonitorManager) UpdateMonitors(ctx context.Context) {
	res, err := mm.Client.Monitors(ctx, &connect.Request[v1.MonitorsRequest]{})
	if err != nil {
		log.Printf("Failed to fetch monitors: %v", err)
		return
	}

	currentIDs := make(map[string]struct{})

	// HTTP monitors: start jobs for new monitors
	for _, m := range res.Msg.HttpMonitors {
		currentIDs[m.Id] = struct{}{}
		if !mm.shouldSchedule(m.Id, m) {
			continue
		}

		interval := time.Duration(intervalToSecond(m.Periodicity)) * time.Second
		task := tasks.Task{
			Interval:          interval,
			RunOnce:           false,
			RunSingleInstance: true,
			StartAfter:        startAfter(m.Id, interval),
			ErrFunc: func(e error) {
				log.Printf("An error occurred when executing task  %s", e)
			},
			FuncWithTaskContext: func(ctx tasks.TaskContext) error {
				monitor := m
				c := context.Background()
				log.Printf("Starting job for monitor %s (%s)", monitor.Id, monitor.Url)
				data, err := mm.JobRunner.HTTPJob(c, monitor, res.Msg.Region)

				if err != nil {
					log.Printf("Monitor check failed for %s (%s): %v", monitor.Id, monitor.Url, err)
					return err
				}
				resp, ingestErr := mm.Client.IngestHTTP(c, &connect.Request[v1.IngestHTTPRequest]{
					Msg: &v1.IngestHTTPRequest{
						MonitorId:     monitor.Id,
						Id:            data.ID,
						Url:           monitor.Url,
						Message:       data.Message,
						Latency:       data.Latency,
						Timing:        data.Timing,
						Headers:       data.Headers,
						Body:          data.Body,
						RequestStatus: data.RequestStatus,
						StatusCode:    int64(data.StatusCode),
						Error:         int64(data.Error),
						CronTimestamp: data.CronTimestamp,
						Timestamp:     data.Timestamp,
					},
				})
				if ingestErr != nil {
					log.Printf("Failed to ingest HTTP result for %s (%s): %v", monitor.Id, monitor.Url, ingestErr)
					return ingestErr
				}
				log.Printf("Monitor check for %s (%s) ingested with status %q (code %d), ingest response: %v", monitor.Id, monitor.Url, data.RequestStatus, data.StatusCode, resp)
				return nil
			},
		}

		if err := mm.Scheduler.AddWithID(m.Id, &task); err != nil {
			log.Printf("Failed to add HTTP monitor job for %s (%s): %v", m.Id, m.Url, err)
			continue
		}
		log.Printf("Started monitoring job for %s (%s)", m.Id, m.Url)
	}

	// TCP monitors: start jobs for new monitors
	for _, m := range res.Msg.TcpMonitors {
		currentIDs[m.Id] = struct{}{}
		if !mm.shouldSchedule(m.Id, m) {
			continue
		}

		interval := time.Duration(intervalToSecond(m.Periodicity)) * time.Second
		task := tasks.Task{
			Interval:          interval,
			RunOnce:           false,
			StartAfter:        startAfter(m.Id, interval),
			RunSingleInstance: true,
			ErrFunc: func(e error) {
				log.Printf("An error occurred when executing TCP task  %s", e)
			},
			FuncWithTaskContext: func(ctx tasks.TaskContext) error {

				monitor := m
				c := context.Background()
				log.Printf("Starting TCP job for monitor %s (%s)", monitor.Id, monitor.Uri)
				data, err := mm.JobRunner.TCPJob(c, monitor, res.Msg.Region)
				if err != nil {
					log.Printf("TCP monitor check failed for %s (%s): %v", monitor.Id, monitor.Uri, err)
					return err
				}
				resp, ingestErr := mm.Client.IngestTCP(c, &connect.Request[v1.IngestTCPRequest]{
					Msg: &v1.IngestTCPRequest{
						MonitorId:     monitor.Id,
						Id:            data.ID,
						Uri:           monitor.Uri,
						Message:       data.Message,
						Latency:       data.Latency,
						RequestStatus: data.RequestStatus,
						Error:         int64(data.Error),
						CronTimestamp: data.CronTimestamp,
						Timestamp:     data.Timestamp,
					},
				})
				if ingestErr != nil {
					log.Printf("Failed to ingest TCP result for %s (%s): %v", monitor.Id, monitor.Uri, ingestErr)
					return ingestErr
				}
				log.Printf("TCP monitor check for %s (%s) ingested with status %q, ingest response: %v", monitor.Id, monitor.Uri, data.RequestStatus, resp)

				return nil
			},
		}

		if err := mm.Scheduler.AddWithID(m.Id, &task); err != nil {
			log.Printf("Failed to add TCP monitor job for %s (%s): %v", m.Id, m.Uri, err)
			continue
		}
		log.Printf("Started TCP monitoring job for %s (%s)", m.Id, m.Uri)
	}

	for _, m := range res.Msg.DnsMonitors {
		currentIDs[m.Id] = struct{}{}
		if !mm.shouldSchedule(m.Id, m) {
			continue
		}

		interval := time.Duration(intervalToSecond(m.Periodicity)) * time.Second
		task := tasks.Task{
			Interval:          interval,
			RunOnce:           false,
			StartAfter:        startAfter(m.Id, interval),
			RunSingleInstance: true,
			FuncWithTaskContext: func(ctx tasks.TaskContext) error {

				monitor := m
				c := context.Background()
				log.Printf("Starting DNS job for monitor %s (%s)", monitor.Id, monitor.Uri)
				data, err := mm.JobRunner.DNSJob(c, monitor)
				if err != nil {
					log.Printf("DNS monitor check failed for %s (%s): %v", monitor.Id, monitor.Uri, err)
					return err
				}
				resp, ingestErr := mm.Client.IngestDNS(c, &connect.Request[v1.IngestDNSRequest]{
					Msg: &v1.IngestDNSRequest{
						MonitorId:     monitor.Id,
						Id:            data.ID,
						Uri:           monitor.Uri,
						Message:       data.Message,
						Latency:       data.Latency,
						RequestStatus: data.RequestStatus,
						Error:         int64(data.Error),
						CronTimestamp: data.CronTimestamp,
						Timestamp:     data.Timestamp,
						Records:       toProtoRecords(data.Records),
					},
				})
				if ingestErr != nil {
					log.Printf("Failed to ingest DNS result for %s (%s): %v", monitor.Id, monitor.Uri, ingestErr)
					return ingestErr
				}
				log.Printf("DNS monitor check for %s (%s) ingested with status %q, ingest response: %v", monitor.Id, monitor.Uri, data.RequestStatus, resp)

				return nil
			},
		}

		if err := mm.Scheduler.AddWithID(m.Id, &task); err != nil {
			log.Printf("Failed to add DNS monitor job for %s (%s): %v", m.Id, m.Uri, err)
			continue
		}
		log.Printf("Started DNS monitoring job for %s (%s)", m.Id, m.Uri)
	}

	for _, m := range res.Msg.IcmpMonitors {
		currentIDs[m.Id] = struct{}{}
		if mm.shouldSchedule(m.Id, m) {

			interval := time.Duration(intervalToSecond(m.Periodicity)) * time.Second
			task := tasks.Task{
				Interval:          interval,
				RunOnce:           false,
				RunSingleInstance: true,
				StartAfter:        startAfter(m.Id, interval),
				FuncWithTaskContext: func(ctx tasks.TaskContext) error {

					monitor := m
					c := context.Background()
					log.Printf("Starting ICMP job for monitor %s (%s)", monitor.Id, monitor.Uri)
					data, err := mm.JobRunner.ICMPJob(c, monitor, res.Msg.Region)
					if err != nil {
						log.Printf("ICMP monitor check failed for %s (%s): %v", monitor.Id, monitor.Uri, err)
						return err
					}
					resp, ingestErr := mm.Client.IngestICMP(c, &connect.Request[v1.IngestICMPRequest]{
						Msg: &v1.IngestICMPRequest{
							MonitorId:       monitor.Id,
							Id:              data.ID,
							Uri:             monitor.Uri,
							Message:         data.Message,
							Latency:         data.Latency,
							LatencyMin:      data.LatencyMin,
							LatencyMax:      data.LatencyMax,
							PacketsSent:     data.PacketsSent,
							PacketsReceived: data.PacketsReceived,
							RequestStatus:   data.RequestStatus,
							Error:           int64(data.Error),
							CronTimestamp:   data.CronTimestamp,
							Timestamp:       data.Timestamp,
							Timing:          data.Timing,
						},
					})
					if ingestErr != nil {
						log.Printf("Failed to ingest ICMP result for %s (%s): %v", monitor.Id, monitor.Uri, ingestErr)
						return ingestErr
					}
					log.Printf("ICMP monitor check succeeded for %s (%s), ingest response: %v", monitor.Id, monitor.Uri, resp)

					return nil
				},
			}
			err := mm.Scheduler.AddWithID(m.Id, &task)
			if err != nil {
				log.Printf("Failed to add ICMP monitor job for %s (%s): %v", m.Id, m.Uri, err)
				continue
			}
			log.Printf("Started ICMP monitoring job for %s (%s)", m.Id, m.Uri)
		}
	}

	for _, m := range res.Msg.GrpcMonitors {
		currentIDs[m.Id] = struct{}{}
		if mm.shouldSchedule(m.Id, m) {

			interval := time.Duration(intervalToSecond(m.Periodicity)) * time.Second
			task := tasks.Task{
				Interval:          interval,
				RunOnce:           false,
				RunSingleInstance: true,
				StartAfter:        startAfter(m.Id, interval),
				FuncWithTaskContext: func(ctx tasks.TaskContext) error {

					monitor := m
					c := context.Background()
					log.Printf("Starting gRPC job for monitor %s (%s)", monitor.Id, monitor.Uri)
					data, err := mm.JobRunner.GRPCJob(c, monitor, res.Msg.Region)
					if err != nil {
						log.Printf("gRPC monitor check failed for %s (%s): %v", monitor.Id, monitor.Uri, err)
						return err
					}
					resp, ingestErr := mm.Client.IngestGRPC(c, &connect.Request[v1.IngestGRPCRequest]{
						Msg: &v1.IngestGRPCRequest{
							MonitorId:     monitor.Id,
							Id:            data.ID,
							Uri:           monitor.Uri,
							Service:       data.Service,
							ServingStatus: data.ServingStatus,
							GrpcCode:      data.GRPCCode,
							Message:       data.Message,
							Latency:       data.Latency,
							RequestStatus: data.RequestStatus,
							Error:         int64(data.Error),
							CronTimestamp: data.CronTimestamp,
							Timestamp:     data.Timestamp,
							Timing:        data.Timing,
						},
					})
					if ingestErr != nil {
						log.Printf("Failed to ingest gRPC result for %s (%s): %v", monitor.Id, monitor.Uri, ingestErr)
						return ingestErr
					}
					log.Printf("gRPC monitor check succeeded for %s (%s), ingest response: %v", monitor.Id, monitor.Uri, resp)

					return nil
				},
			}
			err := mm.Scheduler.AddWithID(m.Id, &task)
			if err != nil {
				log.Printf("Failed to add gRPC monitor job for %s (%s): %v", m.Id, m.Uri, err)
				continue
			}
			log.Printf("Started gRPC monitoring job for %s (%s)", m.Id, m.Uri)
		}
	}

	mm.mu.Lock()
	for id := range mm.Scheduler.Tasks() {
		if _, stillExists := currentIDs[id]; !stillExists {
			mm.Scheduler.Del(id)
			delete(mm.configs, id)
		}
	}
	mm.mu.Unlock()

}

func toProtoRecords(records map[string][]string) map[string]*v1.Records {
	if len(records) == 0 {
		return nil
	}

	protoRecords := make(map[string]*v1.Records, len(records))
	for recordType, values := range records {
		protoRecords[recordType] = &v1.Records{Record: values}
	}

	return protoRecords
}

func intervalToSecond(interval string) int {
	switch interval {
	case Interval30s:
		return 30
	case Interval1m:
		return 60
	case Interval5m:
		return 300
	case Interval10m:
		return 600
	case Interval30m:
		return 1800
	case Interval1h:
		return 3600
	case Interval10s:
		return 10
	default:
		return 0
	}
}
