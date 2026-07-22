import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AWS_CUSTOMER_ROLE_TEMPLATE_MAX_BYTES,
  buildOneTimeCloudFormationQuickCreateUrl,
  parsePublicCustomerRoleTemplateUrl,
  selectCommercialQuickCreateRegion,
  verifyPublicCustomerRoleTemplate,
  withVerifiedPublicCustomerRoleTemplate,
  type OneTimeCloudFormationLaunchInput,
} from "../lib/aws-cloudformation-quick-launch.ts";
import {
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "../lib/aws-template-contract.ts";

const TEMPLATE_URL =
  `https://sutra-demo-artifacts.s3.us-east-1.amazonaws.com/templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml?versionId=reviewed-1`;
const EXTERNAL_ID = "sutra_0123456789abcdefghij";
const REVIEWED_TEMPLATE = new Uint8Array(await readFile(
  new URL("../public/sutra-customer-onboarding-role.yaml", import.meta.url),
));
const CONNECTION_ROUTE_SOURCE = await readFile(
  new URL("../app/api/pilot/connections/route.ts", import.meta.url),
  "utf8",
);

function templateResponse(
  body: BodyInit | null = REVIEWED_TEMPLATE,
  overrides: { readonly status?: number; readonly headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(overrides.headers);
  if (!headers.has("content-length") && body !== null) {
    headers.set("content-length", REVIEWED_TEMPLATE.byteLength.toString());
  }
  return new Response(body, { status: overrides.status ?? 200, headers });
}

function validLaunch(
  overrides: Partial<OneTimeCloudFormationLaunchInput> = {},
): OneTimeCloudFormationLaunchInput {
  return {
    handoffVisible: true,
    partition: "aws",
    templateUrl: TEMPLATE_URL,
    region: "ap-south-1",
    stackName: "sutra-customer-role-123456789012",
    externalId: EXTERNAL_ID,
    vendorCollectorRoleArn: "arn:aws:iam::999988887777:role/sutra/SutraLocalCollectorRole",
    sessionNamePrefix: "sutra-",
    customerTenantId: "cus_0123456789abcdef",
    roleName: "SutraReadOnlyRole",
    ...overrides,
  };
}

test("quick-create puts reviewed trust parameters only in the AWS Console fragment", () => {
  const launchUrl = buildOneTimeCloudFormationQuickCreateUrl(validLaunch());
  assert.notEqual(launchUrl, null);

  const parsed = new URL(launchUrl!);
  assert.equal(parsed.origin, "https://console.aws.amazon.com");
  assert.equal(parsed.pathname, "/cloudformation/home");
  assert.equal(parsed.searchParams.get("region"), "ap-south-1");
  assert.equal(parsed.search.includes(EXTERNAL_ID), false);

  const fragmentQuery = parsed.hash.slice(parsed.hash.indexOf("?") + 1);
  const parameters = new URLSearchParams(fragmentQuery);
  assert.equal(parameters.get("templateURL"), TEMPLATE_URL);
  assert.equal(parameters.get("stackName"), "sutra-customer-role-123456789012");
  assert.equal(parameters.get("param_VendorCollectorRoleArn"), "arn:aws:iam::999988887777:role/sutra/SutraLocalCollectorRole");
  assert.equal(parameters.get("param_ExternalId"), EXTERNAL_ID);
  assert.equal(parameters.get("param_SessionNamePrefix"), "sutra-");
  assert.equal(parameters.get("param_CustomerTenantId"), "cus_0123456789abcdef");
  assert.equal(parameters.get("param_RoleName"), "SutraReadOnlyRole");

  const requestTarget = `${parsed.origin}${parsed.pathname}${parsed.search}`;
  assert.equal(requestTarget.includes(EXTERNAL_ID), false);
});

test("quick-create is absent when the one-time handoff is hidden or the partition is unsupported", () => {
  assert.equal(
    buildOneTimeCloudFormationQuickCreateUrl(validLaunch({
      handoffVisible: false,
      externalId: "deliberately invalid but must never be evaluated",
    })),
    null,
  );
  assert.equal(
    buildOneTimeCloudFormationQuickCreateUrl(validLaunch({ partition: "aws-us-gov" })),
    null,
  );
  assert.equal(
    buildOneTimeCloudFormationQuickCreateUrl(validLaunch({ templateUrl: null })),
    null,
  );
});

test("public template configuration accepts only regional commercial S3 HTTPS URLs", async (t) => {
  for (const accepted of [
    TEMPLATE_URL,
    `https://s3.ap-south-1.amazonaws.com/sutra-demo-artifacts/templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml?versionId=reviewed-2`,
    `https://s3-eu-west-1.amazonaws.com/sutra-demo-artifacts/templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml?versionId=reviewed-3`,
  ]) {
    await t.test(`accepts ${new URL(accepted).hostname}`, () => {
      assert.equal(parsePublicCustomerRoleTemplateUrl(accepted), accepted);
    });
  }

  for (const rejected of [
    "http://sutra-demo-artifacts.s3.us-east-1.amazonaws.com/customer-role.yaml",
    "https://example.com/customer-role.yaml",
    "https://localhost/customer-role.yaml",
    "https://sutra-demo.s3-website-us-east-1.amazonaws.com/customer-role.yaml",
    "https://s3.us-gov-west-1.amazonaws.com/sutra-demo/customer-role.yaml",
    "https://sutra-demo.s3.cn-north-1.amazonaws.com.cn/customer-role.yaml",
    "https://user@sutra-demo.s3.us-east-1.amazonaws.com/customer-role.yaml",
    "https://sutra-demo.s3.us-east-1.amazonaws.com:444/customer-role.yaml",
    "https://sutra-demo.s3.us-east-1.amazonaws.com/customer-role.yaml#fragment",
    "https://sutra-demo.s3.us-east-1.amazonaws.com/customer-role.yaml?X-Amz-Signature=temporary",
    "https://sutra-demo.s3.us-east-1.amazonaws.com/customer-role.yaml?versionId=",
    "https://sutra-demo.s3.us-east-1.amazonaws.com/customer-role.yaml?versionId=null",
    "https://s3.us-east-1.amazonaws.com/sutra-demo",
    "https://s3.amazonaws.com/sutra-demo/customer-role.yaml",
    `https://sutra-demo-artifacts.s3.us-east-1.amazonaws.com/templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml`,
    "https://sutra-demo-artifacts.s3.us-east-1.amazonaws.com/templates/wrong-version/wrong-digest.yaml",
  ]) {
    await t.test(`rejects ${new URL(rejected).hostname}`, () => {
      assert.throws(() => parsePublicCustomerRoleTemplateUrl(rejected));
    });
  }
});

test("quick-create rejects malformed prefilled values without echoing the ExternalId", async (t) => {
  const invalidExternalId = "invalid external id must not appear";
  await t.test("ExternalId", () => {
    assert.throws(
      () => buildOneTimeCloudFormationQuickCreateUrl(validLaunch({ externalId: invalidExternalId })),
      (error) => error instanceof Error &&
        /ExternalId is invalid/u.test(error.message) &&
        !error.message.includes(invalidExternalId),
    );
  });

  for (const [name, override] of [
    ["Region", { region: "us-gov-west-1" }],
    ["stack name", { stackName: "sutra&param_Other=bad" }],
    ["collector principal", { vendorCollectorRoleArn: "arn:aws:iam::999988887777:root" }],
    ["session prefix", { sessionNamePrefix: "s" }],
    ["tenant", { customerTenantId: "tenant&param_Other=bad" }],
    ["role name", { roleName: "Administrator" }],
  ] as const) {
    await t.test(name, () => {
      assert.throws(() => buildOneTimeCloudFormationQuickCreateUrl(validLaunch(override)));
    });
  }
});

test("quick-create chooses the first commercial Region and otherwise fails to a safe default", () => {
  assert.equal(selectCommercialQuickCreateRegion(["ap-south-1", "us-east-1"]), "ap-south-1");
  assert.equal(selectCommercialQuickCreateRegion(["us-gov-west-1", "cn-north-1"]), "us-east-1");
});

test("public template authenticity accepts only the exact reviewed bytes", async () => {
  let requestInput: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  await verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
    fetcher: async (input, init) => {
      requestInput = input;
      requestInit = init;
      return templateResponse();
    },
  });

  assert.equal(requestInput, TEMPLATE_URL);
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.credentials, "omit");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(requestInit?.referrerPolicy, "no-referrer");
  assert.equal(new Headers(requestInit?.headers).has("authorization"), false);
});

test("public template authenticity rejects tampering without reflecting artifact details", async () => {
  const tampered = REVIEWED_TEMPLATE.slice();
  tampered[tampered.byteLength - 1] ^= 1;
  await assert.rejects(
    verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
      fetcher: async () => templateResponse(tampered, {
        headers: { "content-length": tampered.byteLength.toString() },
      }),
    }),
    (error) => error instanceof Error &&
      /could not be verified/u.test(error.message) &&
      !error.message.includes(TEMPLATE_URL) &&
      !error.message.includes(EXTERNAL_ID) &&
      !error.message.includes(AWS_CUSTOMER_ROLE_TEMPLATE_SHA256),
  );
});

test("public template authenticity rejects redirects and never follows them", async () => {
  let redirectMode: RequestRedirect | undefined;
  await assert.rejects(
    verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
      fetcher: async (_input, init) => {
        redirectMode = init?.redirect;
        return templateResponse(null, {
          status: 302,
          headers: { location: "https://example.com/unreviewed.yaml", "content-length": "0" },
        });
      },
    }),
    /could not be verified/u,
  );
  assert.equal(redirectMode, "error");
});

test("public template authenticity enforces declared and streamed byte bounds", async (t) => {
  await t.test("rejects an oversized declared response before reading its stream", async () => {
    let readerRequested = false;
    const response = {
      ok: true,
      redirected: false,
      headers: new Headers({
        "content-length": (AWS_CUSTOMER_ROLE_TEMPLATE_MAX_BYTES + 1).toString(),
      }),
      body: {
        getReader() {
          readerRequested = true;
          throw new Error("oversized responses must not be read");
        },
      },
    } as unknown as Response;
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
        fetcher: async () => response,
      }),
      /could not be verified/u,
    );
    assert.equal(readerRequested, false);
  });

  await t.test("rejects a missing Content-Length", async () => {
    const response = new Response(REVIEWED_TEMPLATE);
    assert.equal(response.headers.has("content-length"), false);
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, { fetcher: async () => response }),
      /could not be verified/u,
    );
  });

  await t.test("accepts the exact bytes delivered as bounded stream chunks", async () => {
    const midpoint = Math.floor(REVIEWED_TEMPLATE.byteLength / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(REVIEWED_TEMPLATE.slice(0, midpoint));
        controller.enqueue(REVIEWED_TEMPLATE.slice(midpoint));
        controller.close();
      },
    });
    await verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
      fetcher: async () => templateResponse(body, {
        headers: { "content-length": REVIEWED_TEMPLATE.byteLength.toString() },
      }),
    });
  });

  await t.test("rejects a stream larger than its declared length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(REVIEWED_TEMPLATE);
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
        fetcher: async () => templateResponse(body, {
          headers: { "content-length": REVIEWED_TEMPLATE.byteLength.toString() },
        }),
      }),
      /could not be verified/u,
    );
  });

  await t.test("rejects a missing response body", async () => {
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
        fetcher: async () => templateResponse(null, {
          headers: { "content-length": REVIEWED_TEMPLATE.byteLength.toString() },
        }),
      }),
      /could not be verified/u,
    );
  });
});

test("public template authenticity fails closed on fetch errors and deadlines", async (t) => {
  await t.test("fetch failure", async () => {
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
        fetcher: async () => {
          throw new Error(`upstream failed for ${TEMPLATE_URL}`);
        },
      }),
      (error) => error instanceof Error &&
        error.message === "The reviewed AWS onboarding template could not be verified",
    );
  });

  await t.test("deadline", async () => {
    await assert.rejects(
      verifyPublicCustomerRoleTemplate(TEMPLATE_URL, {
        timeoutMs: 5,
        fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      }),
      (error) => error instanceof Error &&
        error.message === "The reviewed AWS onboarding template could not be verified",
    );
  });
});

test("connection creation cannot run when public template verification fails", async () => {
  let connectionCreations = 0;
  await assert.rejects(
    withVerifiedPublicCustomerRoleTemplate(
      TEMPLATE_URL,
      async () => {
        connectionCreations += 1;
        return EXTERNAL_ID;
      },
      {
        fetcher: async () => templateResponse(new TextEncoder().encode("tampered"), {
          headers: { "content-length": "8" },
        }),
      },
    ),
    (error) => error instanceof Error &&
      !error.message.includes(TEMPLATE_URL) &&
      !error.message.includes(EXTERNAL_ID),
  );
  assert.equal(connectionCreations, 0);
});

test("connection route authenticates template handoffs and does not require that artifact for customer-managed IaC", () => {
  const routeStart = CONNECTION_ROUTE_SOURCE.indexOf("export async function POST");
  const handoff = CONNECTION_ROUTE_SOURCE.indexOf("const createHandoff =", routeStart);
  const generation = CONNECTION_ROUTE_SOURCE.indexOf("generateExternalId();", routeStart);
  const persistence = CONNECTION_ROUTE_SOURCE.indexOf("createConnectionDraft({", routeStart);
  const customerManagedBranch = CONNECTION_ROUTE_SOURCE.indexOf(
    'if (body.roleProvisioningMode === "customer_managed")',
    routeStart,
  );
  const customerManagedHandoff = CONNECTION_ROUTE_SOURCE.indexOf("createHandoff(null)", customerManagedBranch);
  const verification = CONNECTION_ROUTE_SOURCE.indexOf(
    "return await withVerifiedPublicCustomerRoleTemplate(",
    customerManagedBranch,
  );
  const verifiedCallback = CONNECTION_ROUTE_SOURCE.indexOf("createHandoff,", verification);
  assert.ok(routeStart >= 0);
  assert.ok(handoff > routeStart);
  assert.ok(generation > handoff);
  assert.ok(persistence > generation);
  assert.ok(customerManagedBranch > persistence);
  assert.ok(customerManagedHandoff > customerManagedBranch);
  assert.ok(verification > customerManagedHandoff);
  assert.ok(verifiedCallback > verification);
});
