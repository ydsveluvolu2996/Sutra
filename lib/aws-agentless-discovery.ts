// Pure discovery for agentless scanning: turns an EC2 DescribeVolumes response
// into the AgentlessVolume[] the planner consumes. No AWS call happens here —
// the caller (an AWS-authenticated runner) fetches the response; this only
// normalizes it, deriving the region from each volume's Availability Zone and
// flattening tags. Nothing is inferred that the response did not report.
import type { AgentlessVolume } from "./aws-agentless-scan-plan.ts";

interface DescribedTag { readonly Key?: string | null; readonly Value?: string | null }
interface DescribedAttachment { readonly InstanceId?: string | null; readonly State?: string | null }
interface DescribedVolume {
  readonly VolumeId?: string | null;
  readonly Size?: number | null;
  readonly Encrypted?: boolean | null;
  readonly AvailabilityZone?: string | null;
  readonly Attachments?: readonly DescribedAttachment[] | null;
  readonly Tags?: readonly DescribedTag[] | null;
}
export interface DescribeVolumesResponse {
  readonly Volumes?: readonly DescribedVolume[] | null;
}

// "ap-south-1a" -> "ap-south-1"; leaves an already-region value untouched.
function regionFromAvailabilityZone(zone: string | null | undefined, fallback: string | null): string | null {
  if (typeof zone !== "string" || zone.trim().length === 0) return fallback;
  return /^[a-z]{2}-[a-z]+-\d+[a-z]$/u.test(zone) ? zone.slice(0, -1) : zone;
}

function tagsOf(tags: readonly DescribedTag[] | null | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (typeof tag?.Key === "string" && typeof tag?.Value === "string") record[tag.Key] = tag.Value;
  }
  return record;
}

export function normalizeDescribedVolumes(
  response: DescribeVolumesResponse | null | undefined,
  options: { readonly region?: string | null } = {},
): readonly AgentlessVolume[] {
  const fallbackRegion = options.region ?? null;
  const rawVolumes = response?.Volumes;
  const volumes: readonly DescribedVolume[] = Array.isArray(rawVolumes) ? rawVolumes : [];
  return volumes
    .flatMap((volume): AgentlessVolume[] => {
      const volumeId = typeof volume?.VolumeId === "string" && volume.VolumeId.length > 0 ? volume.VolumeId : null;
      const region = regionFromAvailabilityZone(volume?.AvailabilityZone, fallbackRegion);
      if (volumeId === null || region === null) return []; // cannot target a volume with no id/region
      const rawAttachments = volume?.Attachments;
      const attachments: readonly DescribedAttachment[] = Array.isArray(rawAttachments) ? rawAttachments : [];
      const attachment = attachments.find((entry) => typeof entry?.InstanceId === "string");
      return [{
        volumeId,
        region,
        sizeGiB: typeof volume?.Size === "number" && Number.isFinite(volume.Size) ? volume.Size : 0,
        encrypted: volume?.Encrypted === true,
        instanceId: attachment?.InstanceId ?? null,
        attached: attachments.some((entry) => entry?.State === "attached" || typeof entry?.InstanceId === "string"),
        tags: tagsOf(volume?.Tags),
      }];
    })
    .sort((left, right) => left.volumeId.localeCompare(right.volumeId, "en-US"));
}
