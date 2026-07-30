import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";

import { createSamlAuthorizationUrl } from "../lib/saml-authn-request.ts";
import { verifySamlAssertion } from "../lib/saml-assertion.ts";
import {
  hostedSamlProviderIssues,
  parseHostedSamlProviders,
  type HostedSamlProviderConfig,
} from "../lib/hosted-saml-providers.ts";
import { createSamlTransaction } from "../lib/saml-transaction.ts";

const ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const ENTITY_ID = "https://idp.example.test/metadata";
const SP_ENTITY_ID = "https://www.sutracmdb.com/api/auth/saml/metadata";
const ACS = "https://www.sutracmdb.com/api/auth/saml/callback";
const REQUEST_ID = "_request12345678";
const ASSERTION_ID = "_assertion12345678";
const NOW = Date.parse("2026-07-30T10:00:00.000Z");

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(1 + derLength(length).length + length);
  result[0] = tag;
  result.set(derLength(length), 1);
  let offset = 1 + derLength(length).length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fakeCertificate(spki: Uint8Array): string {
  const emptySequence = der(0x30);
  const tbs = der(
    0x30,
    der(0x02, Uint8Array.of(1)),
    emptySequence,
    emptySequence,
    emptySequence,
    emptySequence,
    spki,
  );
  return base64(der(0x30, tbs, emptySequence, der(0x03, Uint8Array.of(0, 0))));
}

function provider(certificate: string): HostedSamlProviderConfig {
  return {
    id: "enterprise",
    label: "Enterprise SSO",
    tenantId: "tenant-alpha",
    entityId: ENTITY_ID,
    ssoUrl: "https://idp.example.test/sso",
    signingCertificates: [certificate],
    tenantAttribute: "tenant_id",
    emailAttribute: "email",
    displayNameAttribute: "display_name",
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  };
}

function signedInfo(digest: string): string {
  return `<ds:SignedInfo xmlns:ds="${DS_NS}"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod><ds:Reference URI="#${ASSERTION_ID}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
}

function assertionWithoutSignature(input: {
  readonly audience?: string;
  readonly issuer?: string;
  readonly tenant?: string;
  readonly notBefore?: string;
  readonly notOnOrAfter?: string;
} = {}): string {
  const issuer = input.issuer ?? ENTITY_ID;
  const notBefore = input.notBefore ?? "2026-07-30T09:59:00.000Z";
  const notOnOrAfter = input.notOnOrAfter ?? "2026-07-30T10:05:00.000Z";
  return `<saml:Assertion xmlns:saml="${ASSERTION_NS}" ID="${ASSERTION_ID}" IssueInstant="2026-07-30T10:00:00.000Z" Version="2.0"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">user-123</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${REQUEST_ID}" NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS}"></saml:SubjectConfirmationData></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${input.audience ?? SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="2026-07-30T10:00:00.000Z" SessionNotOnOrAfter="${notOnOrAfter}"></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="tenant_id"><saml:AttributeValue>${input.tenant ?? "tenant-alpha"}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="email"><saml:AttributeValue>analyst@example.test</saml:AttributeValue></saml:Attribute><saml:Attribute Name="display_name"><saml:AttributeValue>Enterprise Analyst</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}

async function signedResponse(
  privateKey: CryptoKey,
  input: Parameters<typeof assertionWithoutSignature>[0] = {},
): Promise<string> {
  const assertion = assertionWithoutSignature(input);
  const digest = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(assertion))));
  const info = signedInfo(digest);
  const signature = base64(new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(info),
  )));
  const signedAssertion = assertion.replace(
    "</saml:Issuer>",
    `</saml:Issuer><ds:Signature xmlns:ds="${DS_NS}">${info}<ds:SignatureValue>${signature}</ds:SignatureValue></ds:Signature>`,
  );
  return `<samlp:Response xmlns:samlp="${PROTOCOL_NS}" xmlns:saml="${ASSERTION_NS}" Destination="${ACS}" ID="_response12345678" InResponseTo="${REQUEST_ID}" IssueInstant="2026-07-30T10:00:00.000Z" Version="2.0"><saml:Issuer>${input.issuer ?? ENTITY_ID}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></samlp:StatusCode></samlp:Status>${signedAssertion}</samlp:Response>`;
}

async function fixture(): Promise<{
  readonly privateKey: CryptoKey;
  readonly provider: HostedSamlProviderConfig;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, provider: provider(fakeCertificate(spki)) };
}

test("enterprise SAML configuration is exact, certificate-pinned, and tenant-aware", async () => {
  const current = await fixture();
  const parsed = parseHostedSamlProviders(JSON.stringify([current.provider]));
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.providers[0]?.tenantId, "tenant-alpha");

  for (const broken of [
    undefined,
    "not json",
    JSON.stringify([{ ...current.provider, tenantId: "" }]),
    JSON.stringify([{ ...current.provider, entityId: "javascript:alert(1)" }]),
    JSON.stringify([{ ...current.provider, signingCertificates: [] }]),
    JSON.stringify([{ ...current.provider, unexpected: true }]),
  ]) {
    if (broken === undefined) {
      assert.deepEqual(hostedSamlProviderIssues(broken), [], "SAML remains optional in OIDC-only mode");
    } else {
      assert.ok(hostedSamlProviderIssues(broken).length > 0);
    }
  }
});

test("SAML AuthnRequest is SP-initiated, request-bound, and uses the exact ACS and audience", async () => {
  const current = await fixture();
  const transaction = createSamlTransaction("enterprise", "/dashboard", null, NOW);
  const authorization = new URL(createSamlAuthorizationUrl(current.provider, transaction, SP_ENTITY_ID, ACS));
  assert.equal(authorization.origin, "https://idp.example.test");
  assert.equal(authorization.searchParams.get("RelayState"), transaction.relayState);
  const request = inflateRawSync(Buffer.from(authorization.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
  assert.match(request, new RegExp(`ID="${transaction.requestId}"`, "u"));
  assert.match(request, new RegExp(`AssertionConsumerServiceURL="${ACS}"`, "u"));
  assert.match(request, new RegExp(`<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`, "u"));
});

test("a valid RSA-SHA256 signed assertion maps into the configured tenant identity namespace", async () => {
  const current = await fixture();
  const result = await verifySamlAssertion(await signedResponse(current.privateKey), {
    provider: current.provider,
    identityIssuer: "https://www.sutracmdb.com/identity/saml/tenant-alpha/enterprise",
    audience: SP_ENTITY_ID,
    acsUrl: ACS,
    requestId: REQUEST_ID,
    now: NOW,
  });
  assert.equal(result.assertionId, ASSERTION_ID);
  assert.equal(result.identity.issuer, "https://www.sutracmdb.com/identity/saml/tenant-alpha/enterprise");
  assert.equal(result.identity.subject, "tenant-alpha:user-123");
  assert.equal(result.identity.email, "analyst@example.test");
  assert.equal(result.identity.displayName, "Enterprise Analyst");
});

test("SAML validation rejects tampering, wrong audience, issuer, tenant, and expiry", async () => {
  const current = await fixture();
  const verification = {
    provider: current.provider,
    identityIssuer: "https://www.sutracmdb.com/identity/saml/tenant-alpha/enterprise",
    audience: SP_ENTITY_ID,
    acsUrl: ACS,
    requestId: REQUEST_ID,
    now: NOW,
  } as const;
  const valid = await signedResponse(current.privateKey);
  await assert.rejects(
    verifySamlAssertion(valid.replace("analyst@example.test", "attacker@example.test"), verification),
    /digest/iu,
  );
  await assert.rejects(
    verifySamlAssertion(await signedResponse(current.privateKey, { audience: "https://other.example/sp" }), verification),
    /audience/iu,
  );
  await assert.rejects(
    verifySamlAssertion(await signedResponse(current.privateKey, { issuer: "https://other-idp.example/metadata" }), verification),
    /issuer/iu,
  );
  await assert.rejects(
    verifySamlAssertion(await signedResponse(current.privateKey, { tenant: "tenant-beta" }), verification),
    /tenant binding/iu,
  );
  await assert.rejects(
    verifySamlAssertion(await signedResponse(current.privateKey, {
      notBefore: "2026-07-30T09:40:00.000Z",
      notOnOrAfter: "2026-07-30T09:50:00.000Z",
    }), verification),
    /expired|lifetime/iu,
  );
});
