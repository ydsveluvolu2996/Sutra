import type { HostedSamlProviderConfig } from "./hosted-saml-providers.ts";
import type { SamlTransaction } from "./saml-transaction.ts";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\"", "&quot;");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A valid raw DEFLATE stream using stored blocks, avoiding Node-only compression APIs. */
function deflateStored(bytes: Uint8Array): Uint8Array {
  const chunks: number[] = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 65_535) {
    const length = Math.min(65_535, bytes.length - offset);
    const final = offset + length >= bytes.length;
    chunks.push(final ? 0x01 : 0x00, length & 0xff, (length >>> 8) & 0xff);
    const inverse = (~length) & 0xffff;
    chunks.push(inverse & 0xff, (inverse >>> 8) & 0xff);
    for (let index = 0; index < length; index += 1) chunks.push(bytes[offset + index] ?? 0);
    if (final) break;
  }
  return Uint8Array.from(chunks);
}

export function createSamlAuthorizationUrl(
  provider: HostedSamlProviderConfig,
  transaction: SamlTransaction,
  spEntityId: string,
  acsUrl: string,
): string {
  const issueInstant = new Date(transaction.createdAt).toISOString();
  const request = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${xml(transaction.requestId)}" Version="2.0" IssueInstant="${xml(issueInstant)}" Destination="${xml(provider.ssoUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${xml(acsUrl)}"><saml:Issuer>${xml(spEntityId)}</saml:Issuer><samlp:NameIDPolicy Format="${xml(provider.nameIdFormat)}" AllowCreate="true"/></samlp:AuthnRequest>`;
  const url = new URL(provider.ssoUrl);
  url.searchParams.set("SAMLRequest", base64(deflateStored(new TextEncoder().encode(request))));
  url.searchParams.set("RelayState", transaction.relayState);
  return url.toString();
}

export function createSamlMetadata(spEntityId: string, acsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xml(spEntityId)}"><SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</NameIDFormat><NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat><AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xml(acsUrl)}" index="0" isDefault="true"/></SPSSODescriptor></EntityDescriptor>`;
}
