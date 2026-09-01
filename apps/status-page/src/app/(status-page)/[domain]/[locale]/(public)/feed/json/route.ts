import { notFound, unauthorized } from "next/navigation";

import { auth } from "../../../../../../../lib/auth";
import { getQueryClient, trpc } from "../../../../../../../lib/trpc/server";

export const revalidate = 60;

export async function GET(
  _request: Request,
  props: { params: Promise<{ domain: string }> },
) {
  try {
    const queryClient = getQueryClient();
    const { domain } = await props.params;

    const _page = await queryClient.fetchQuery(
      trpc.statusPage.getLight.queryOptions({ slug: domain }),
    );

    if (!_page) return notFound();

    if (_page.accessType === "password") {
      const url = new URL(_request.url);
      const authorized = await queryClient.fetchQuery(
        trpc.statusPage.isPasswordAuthorized.queryOptions({
          slug: _page.slug,
          queryPassword: url.searchParams.get("pw"),
        }),
      );
      if (!authorized) return unauthorized();
    }

    if (_page.accessType === "email-domain") {
      const session = await auth();
      const user = session?.user;
      const allowedDomains = _page.authEmailDomains ?? [];
      if (!user || !user.email) return unauthorized();
      if (!allowedDomains.includes(user.email.split("@")[1]))
        return unauthorized();
    }

    const page = await queryClient.fetchQuery(
      trpc.statusPage.get.queryOptions({ slug: domain }),
    );

    if (!page) return notFound();

    const res = {
      title: page.title,
      description: page.description,
      status: page.status,
      updatedAt: new Date(),
      // @deprecated Use pageComponents instead
      monitors: page.monitors.map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        description: monitor.description,
        status: monitor.status,
      })),
      // New field - exposes the page component structure
      pageComponents: page.pageComponents.map((component) => ({
        id: component.id,
        name: component.name,
        description: component.description,
        monitorId: component.monitorId,
        order: component.order,
        groupId: component.groupId,
        groupOrder: component.groupOrder,
      })),
      pageComponentGroups: page.pageComponentGroups.map((group) => ({
        id: group.id,
        name: group.name,
      })),
      maintenances: page.maintenances.map((maintenance) => ({
        id: maintenance.id,
        name: maintenance.title,
        message: maintenance.message,
        from: maintenance.from,
        to: maintenance.to,
        updatedAt: maintenance.updatedAt,
        // @deprecated Use components instead - returning monitor IDs for backwards compatibility
        monitors: maintenance.maintenancesToPageComponents
          .map((item) => item.pageComponent.monitorId)
          .filter((id): id is number => id !== null),
        // New field - references page component IDs
        pageComponents: maintenance.maintenancesToPageComponents.map(
          (item) => item.pageComponentId,
        ),
      })),
      statusReports: page.statusReports.map((report) => ({
        id: report.id,
        title: report.title,
        updatedAt: report.updatedAt,
        status: report.status,
        // @deprecated Use components instead - returning monitor IDs for backwards compatibility
        monitors: report.statusReportsToPageComponents
          .map((item) => item.pageComponent.monitorId)
          .filter((id): id is number => id !== null),
        // New field - references page component IDs
        pageComponents: report.statusReportsToPageComponents.map(
          (item) => item.pageComponentId,
        ),
        statusReportUpdates: report.statusReportUpdates.map((update) => ({
          id: update.id,
          status: update.status,
          message: update.message,
          date: update.date,
          updatedAt: update.updatedAt,
        })),
      })),
    };

    // A public status feed that a browser cannot read is half a feature: the
    // obvious consumer is a badge on your own site or app, and that is a
    // cross-origin fetch. The data is already served to anyone who asks — the
    // password branch above returns unauthorized before reaching here — so the
    // header grants nothing new. It is set ONLY for accessType "public";
    // password and email-domain pages keep the same-origin restriction, which
    // is what stops a browser on any site from reading a gated page's feed.
    const isPublic = _page.accessType === "public";

    return new Response(JSON.stringify(res), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(isPublic
          ? {
              "Access-Control-Allow-Origin": "*",
              // A consumer polling this every minute should be served by a
              // cache, not by the database behind it.
              "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
            }
          : {}),
      },
    });
  } catch (error) {
    console.error("Error generating feed:", error);
    throw error;
  }
}
