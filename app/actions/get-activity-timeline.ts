"use server";

import { getAllHookActivityEntries } from "@/src/hooks/hook-activity-store";
import { bucketActivity, type ActivityBucket } from "@/src/hooks/activity-timeline";

/**
 * Time-bucketed activity for the enforcement timeline.
 *
 * Reads every retained entry rather than the current page: the chart's whole
 * job is the shape over a window, and a page is an arbitrary slice of it that
 * would make the line change whenever someone paged.
 */
export async function getActivityTimelineAction(): Promise<ActivityBucket[]> {
  try {
    return bucketActivity(getAllHookActivityEntries());
  } catch {
    // Non-critical: a missing or unreadable store means no chart, not an error
    // page over the activity view.
    return [];
  }
}
