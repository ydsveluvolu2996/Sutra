const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u;
const ROLE_ARN = /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9_+=,.@/-]+)$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;

export const SUTRA_EKS_KUBERNETES_GROUP = "sutra:readers";
export const SUTRA_VISIBILITY_CHART = "./deploy/charts/sutra-visibility";

export interface EksEnrollmentPlan {
  readonly schemaVersion: "sutra.eks-enrollment-plan.v1";
  readonly clusterName: string;
  readonly region: string;
  readonly customerRoleArn: string;
  readonly kubernetesGroup: typeof SUTRA_EKS_KUBERNETES_GROUP;
  readonly mode: "visibility";
  readonly commands: {
    readonly createAccessEntry: string;
    readonly installVisibilityRole: string;
  };
  readonly safety: {
    readonly secretRead: false;
    readonly mutations: false;
    readonly runtimeSensor: false;
    readonly trivyReports: false;
  };
}

export class EksEnrollmentError extends Error {
  public readonly code = "INVALID_EKS_ENROLLMENT";

  public constructor() {
    super("EKS enrollment plan rejected");
    this.name = "EksEnrollmentError";
  }
}

function reject(): never {
  throw new EksEnrollmentError();
}

/**
 * Produces a non-secret, reviewable customer-admin plan. Sutra never executes
 * these mutations from a browser request.
 */
export function createEksEnrollmentPlan(input: {
  readonly clusterName: string;
  readonly region: string;
  readonly accountId: string;
  readonly customerRoleArn: string;
}): EksEnrollmentPlan {
  if (!CLUSTER_NAME.test(input.clusterName) || !AWS_REGION.test(input.region)) reject();
  if (!ACCOUNT_ID.test(input.accountId)) reject();
  const role = ROLE_ARN.exec(input.customerRoleArn);
  if (
    role === null || role[2] !== input.accountId ||
    role[3] === undefined || role[3].startsWith("/") ||
    role[3].endsWith("/") || role[3].includes("//")
  ) reject();
  const partition = role[1];
  if (
    (partition === "aws" && input.region.includes("-gov-")) ||
    (partition === "aws-us-gov" && !input.region.includes("-gov-")) ||
    partition === "aws-cn"
  ) reject();
  return {
    schemaVersion: "sutra.eks-enrollment-plan.v1",
    clusterName: input.clusterName,
    region: input.region,
    customerRoleArn: input.customerRoleArn,
    kubernetesGroup: SUTRA_EKS_KUBERNETES_GROUP,
    mode: "visibility",
    commands: {
      createAccessEntry:
        `aws eks create-access-entry --cluster-name ${input.clusterName} ` +
        `--principal-arn ${input.customerRoleArn} --type STANDARD ` +
        `--kubernetes-groups ${SUTRA_EKS_KUBERNETES_GROUP} --region ${input.region}`,
      installVisibilityRole:
        `helm upgrade --install sutra-visibility ${SUTRA_VISIBILITY_CHART} ` +
        `--namespace sutra-system --create-namespace ` +
        `--set-string kubernetesGroup=${SUTRA_EKS_KUBERNETES_GROUP} --atomic --wait`,
    },
    safety: {
      secretRead: false,
      mutations: false,
      runtimeSensor: false,
      trivyReports: false,
    },
  };
}
