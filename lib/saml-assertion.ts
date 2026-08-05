import type { HostedIdentity } from "../db/auth-repository.ts";
import type { HostedSamlProviderConfig } from "./hosted-saml-providers.ts";
import { constantTimeSamlValue } from "./saml-transaction.ts";

const XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const SAML_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const SUCCESS_STATUS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER_CONFIRMATION = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const CLOCK_SKEW_MS = 60_000;
const MAX_ASSERTION_LIFETIME_MS = 10 * 60_000;
const MAX_XML_BYTES = 256 * 1024;
const encoder = new TextEncoder();

interface XmlAttribute {
  readonly qName: string;
  readonly prefix: string;
  readonly localName: string;
  readonly namespaceUri: string;
  readonly value: string;
}

interface XmlText {
  readonly kind: "text";
  readonly value: string;
}

interface XmlElement {
  readonly kind: "element";
  readonly qName: string;
  readonly prefix: string;
  readonly localName: string;
  readonly namespaceUri: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
  readonly namespaces: ReadonlyMap<string, string>;
}

type XmlNode = XmlElement | XmlText;
interface RawAttribute { readonly name: string; readonly value: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;

function splitName(name: string): { readonly prefix: string; readonly localName: string } {
  if (!NAME.test(name)) throw new Error("SAML XML contains an invalid name");
  const separator = name.indexOf(":");
  return separator < 0
    ? { prefix: "", localName: name }
    : { prefix: name.slice(0, separator), localName: name.slice(separator + 1) };
}

function xmlCharacter(codePoint: number): string {
  const valid = codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
  if (!valid) throw new Error("SAML XML contains an invalid character");
  return String.fromCodePoint(codePoint);
}

function decodeXml(value: string): string {
  let valid = true;
  const decoded = value.replace(/&([^;]{1,16});/gu, (_whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    if (/^#[0-9]{1,7}$/u.test(entity)) return xmlCharacter(Number.parseInt(entity.slice(1), 10));
    if (/^#x[0-9A-Fa-f]{1,6}$/u.test(entity)) return xmlCharacter(Number.parseInt(entity.slice(2), 16));
    valid = false;
    return "";
  });
  if (!valid || decoded.includes("&")) throw new Error("SAML XML contains an unsupported entity");
  return decoded;
}

class StrictXmlParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/u, "");
  }

  parse(): XmlElement {
    this.space();
    if (this.source.startsWith("<?xml", this.index)) {
      const end = this.source.indexOf("?>", this.index);
      if (end < 0) throw new Error("SAML XML declaration is invalid");
      const declaration = this.source.slice(this.index, end + 2);
      if (!/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?\s*\?>$/u.test(declaration)) {
        throw new Error("SAML XML declaration is unsupported");
      }
      this.index = end + 2;
      this.space();
    }
    this.skipComments();
    if (this.source.startsWith("<!", this.index) || this.source.startsWith("<?", this.index)) {
      throw new Error("SAML XML declarations and entities are forbidden");
    }
    const namespaces = new Map<string, string>([
      ["xml", "http://www.w3.org/XML/1998/namespace"],
      ["", ""],
    ]);
    const root = this.element(namespaces, 0);
    this.space();
    this.skipComments();
    this.space();
    if (this.index !== this.source.length) throw new Error("SAML XML has trailing content");
    return root;
  }

  private skipComments(): void {
    while (this.source.startsWith("<!--", this.index)) {
      const end = this.source.indexOf("-->", this.index + 4);
      if (end < 0 || this.source.slice(this.index + 4, end).includes("--")) {
        throw new Error("SAML XML comment is invalid");
      }
      this.index = end + 3;
      this.space();
    }
  }

  private space(): void {
    while (/[\t\n ]/u.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private name(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(this.source.slice(this.index));
    if (match === null || !NAME.test(match[0])) throw new Error("SAML XML contains an invalid name");
    this.index += match[0].length;
    return match[0];
  }

  private quoted(): string {
    const quote = this.source[this.index];
    if (quote !== "\"" && quote !== "'") throw new Error("SAML XML attribute is not quoted");
    const end = this.source.indexOf(quote, this.index + 1);
    if (end < 0) throw new Error("SAML XML attribute is unterminated");
    const raw = this.source.slice(this.index + 1, end);
    if (raw.includes("<")) throw new Error("SAML XML attribute is invalid");
    this.index = end + 1;
    return decodeXml(raw.replace(/[\t\n\r]/gu, " "));
  }

  private element(parentNamespaces: ReadonlyMap<string, string>, depth: number): XmlElement {
    if (depth > 64 || this.source[this.index] !== "<" || this.source[this.index + 1] === "/") {
      throw new Error("SAML XML structure is invalid");
    }
    this.index += 1;
    const qName = this.name();
    const rawAttributes: RawAttribute[] = [];
    while (true) {
      this.space();
      if (this.source.startsWith("/>", this.index)) {
        this.index += 2;
        return this.finishElement(qName, rawAttributes, [], parentNamespaces);
      }
      if (this.source[this.index] === ">") {
        this.index += 1;
        break;
      }
      const name = this.name();
      this.space();
      if (this.source[this.index] !== "=") throw new Error("SAML XML attribute is invalid");
      this.index += 1;
      this.space();
      const value = this.quoted();
      if (rawAttributes.some((attribute) => attribute.name === name)) throw new Error("SAML XML repeats an attribute");
      rawAttributes.push({ name, value });
      if (rawAttributes.length > 128) throw new Error("SAML XML has too many attributes");
    }

    const namespaces = this.namespaces(rawAttributes, parentNamespaces);
    const children: XmlNode[] = [];
    while (true) {
      if (this.source.startsWith(`</${qName}`, this.index)) {
        this.index += qName.length + 2;
        this.space();
        if (this.source[this.index] !== ">") throw new Error("SAML XML closing tag is invalid");
        this.index += 1;
        break;
      }
      if (this.source.startsWith("<!--", this.index)) {
        this.skipComments();
        continue;
      }
      if (this.source.startsWith("<![CDATA[", this.index)) {
        const end = this.source.indexOf("]]>", this.index + 9);
        if (end < 0) throw new Error("SAML XML CDATA is unterminated");
        children.push({ kind: "text", value: this.source.slice(this.index + 9, end) });
        this.index = end + 3;
        continue;
      }
      if (this.source.startsWith("<!", this.index) || this.source.startsWith("<?", this.index)) {
        throw new Error("SAML XML declarations and entities are forbidden");
      }
      if (this.source[this.index] === "<") {
        children.push(this.element(namespaces, depth + 1));
      } else {
        const end = this.source.indexOf("<", this.index);
        if (end < 0) throw new Error("SAML XML element is unterminated");
        const raw = this.source.slice(this.index, end);
        children.push({ kind: "text", value: decodeXml(raw) });
        this.index = end;
      }
      if (children.length > 4096) throw new Error("SAML XML has too many nodes");
    }
    return this.finishElement(qName, rawAttributes, children, parentNamespaces);
  }

  private namespaces(
    rawAttributes: readonly RawAttribute[],
    parentNamespaces: ReadonlyMap<string, string>,
  ): ReadonlyMap<string, string> {
    const namespaces = new Map(parentNamespaces);
    for (const attribute of rawAttributes) {
      if (attribute.name !== "xmlns" && !attribute.name.startsWith("xmlns:")) continue;
      const prefix = attribute.name === "xmlns" ? "" : attribute.name.slice(6);
      if (
        prefix === "xmlns"
        || (prefix === "xml" && attribute.value !== "http://www.w3.org/XML/1998/namespace")
        || (prefix !== "" && attribute.value === "")
        || attribute.value === "http://www.w3.org/2000/xmlns/"
      ) throw new Error("SAML XML namespace is invalid");
      namespaces.set(prefix, attribute.value);
    }
    return namespaces;
  }

  private finishElement(
    qName: string,
    rawAttributes: readonly RawAttribute[],
    children: readonly XmlNode[],
    parentNamespaces: ReadonlyMap<string, string>,
  ): XmlElement {
    const namespaces = this.namespaces(rawAttributes, parentNamespaces);
    const name = splitName(qName);
    const namespaceUri = namespaces.get(name.prefix);
    if (namespaceUri === undefined || (name.prefix !== "" && namespaceUri === "")) {
      throw new Error("SAML XML uses an unbound namespace");
    }
    const attributes: XmlAttribute[] = [];
    const expandedNames = new Set<string>();
    for (const raw of rawAttributes) {
      if (raw.name === "xmlns" || raw.name.startsWith("xmlns:")) continue;
      const attributeName = splitName(raw.name);
      const attributeNamespace = attributeName.prefix === ""
        ? ""
        : namespaces.get(attributeName.prefix);
      if (attributeNamespace === undefined || (attributeName.prefix !== "" && attributeNamespace === "")) {
        throw new Error("SAML XML uses an unbound attribute namespace");
      }
      const expanded = `${attributeNamespace}\0${attributeName.localName}`;
      if (expandedNames.has(expanded)) throw new Error("SAML XML repeats an expanded attribute");
      expandedNames.add(expanded);
      attributes.push({
        qName: raw.name,
        prefix: attributeName.prefix,
        localName: attributeName.localName,
        namespaceUri: attributeNamespace,
        value: raw.value,
      });
    }
    return { kind: "element", qName, ...name, namespaceUri, attributes, children, namespaces };
  }
}

function elementChildren(element: XmlElement, namespaceUri: string, localName: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => child.kind === "element"
      && child.namespaceUri === namespaceUri
      && child.localName === localName,
  );
}

function descendants(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  for (const child of element.children) {
    if (child.kind !== "element") continue;
    result.push(child, ...descendants(child));
  }
  return result;
}

function one(elements: readonly XmlElement[], label: string): XmlElement {
  if (elements.length !== 1 || elements[0] === undefined) throw new Error(`SAML ${label} is missing or ambiguous`);
  return elements[0];
}

function attribute(element: XmlElement, name: string): string {
  const values = element.attributes.filter((candidate) => candidate.prefix === "" && candidate.localName === name);
  if (values.length !== 1 || values[0] === undefined) throw new Error(`SAML ${name} attribute is missing or ambiguous`);
  return values[0].value;
}

function optionalAttribute(element: XmlElement, name: string): string | null {
  const values = element.attributes.filter((candidate) => candidate.prefix === "" && candidate.localName === name);
  if (values.length > 1) throw new Error(`SAML ${name} attribute is ambiguous`);
  return values[0]?.value ?? null;
}

function text(element: XmlElement, maximum = 2048): string {
  if (element.children.some((child) => child.kind === "element")) throw new Error("SAML text value has unsupported markup");
  const value = element.children.map((child) => child.kind === "text" ? child.value : "").join("").trim();
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("SAML text value is invalid");
  }
  return value;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r/gu, "&#xD;");
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replaceAll("\"", "&quot;")
    .replace(/\t/gu, "&#x9;")
    .replace(/\n/gu, "&#xA;");
}

function canonicalize(
  element: XmlElement,
  omitted: XmlElement | null = null,
  renderedNamespaces = new Map<string, string>(),
): string {
  if (element === omitted) return "";
  const visiblePrefixes = new Set<string>();
  if (element.prefix !== "" || element.namespaceUri !== "") visiblePrefixes.add(element.prefix);
  if (element.prefix === "" && element.namespaceUri === "" && (renderedNamespaces.get("") ?? "") !== "") {
    visiblePrefixes.add("");
  }
  for (const attr of element.attributes) {
    if (attr.prefix !== "" && attr.prefix !== "xml") visiblePrefixes.add(attr.prefix);
  }
  const declarations = [...visiblePrefixes]
    .filter((prefix) => prefix !== "xml")
    .map((prefix) => {
      const uri = element.namespaces.get(prefix);
      if (uri === undefined) throw new Error("SAML canonical namespace is unavailable");
      return { prefix, uri };
    })
    .filter(({ prefix, uri }) => renderedNamespaces.get(prefix) !== uri)
    .sort((left, right) => left.prefix.localeCompare(right.prefix));
  const nextRendered = new Map(renderedNamespaces);
  for (const declaration of declarations) nextRendered.set(declaration.prefix, declaration.uri);
  const namespaceSource = declarations.map(({ prefix, uri }) =>
    prefix === ""
      ? ` xmlns="${escapeAttribute(uri)}"`
      : ` xmlns:${prefix}="${escapeAttribute(uri)}"`,
  ).join("");
  const attributeSource = [...element.attributes]
    .sort((left, right) =>
      left.namespaceUri === right.namespaceUri
        ? left.localName.localeCompare(right.localName)
        : left.namespaceUri.localeCompare(right.namespaceUri),
    )
    .map((item) => ` ${item.qName}="${escapeAttribute(item.value)}"`)
    .join("");
  const childSource = element.children.map((child) =>
    child.kind === "text"
      ? escapeText(child.value)
      : canonicalize(child, omitted, nextRendered),
  ).join("");
  return `<${element.qName}${namespaceSource}${attributeSource}>${childSource}</${element.qName}>`;
}

function base64Bytes(value: string, label: string, maximum = MAX_XML_BYTES): Uint8Array {
  const normalized = value.replace(/[\t\n\r ]/gu, "");
  if (
    normalized.length < 4
    || normalized.length > Math.ceil(maximum / 3) * 4 + 4
    || normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)
  ) throw new Error(`${label} is invalid`);
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length > maximum) throw new Error(`${label} is too large`);
    let roundTrip = "";
    for (const byte of bytes) roundTrip += String.fromCharCode(byte);
    if (btoa(roundTrip) !== normalized) throw new Error(`${label} is invalid`);
    return bytes;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

interface DerValue {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function derValue(bytes: Uint8Array, start: number): DerValue {
  if (start < 0 || start + 2 > bytes.length) throw new Error("SAML signing certificate is invalid");
  const tag = bytes[start] ?? -1;
  const firstLength = bytes[start + 1] ?? -1;
  let length = firstLength;
  let contentStart = start + 2;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 4 || contentStart + lengthBytes > bytes.length || bytes[contentStart] === 0) {
      throw new Error("SAML signing certificate is invalid");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) length = length * 256 + (bytes[contentStart + index] ?? 0);
    contentStart += lengthBytes;
    if (length < 128) throw new Error("SAML signing certificate is invalid");
  }
  const end = contentStart + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error("SAML signing certificate is invalid");
  return { tag, start, contentStart, end };
}

function derChildren(bytes: Uint8Array, value: DerValue): DerValue[] {
  const values: DerValue[] = [];
  let offset = value.contentStart;
  while (offset < value.end) {
    const child = derValue(bytes, offset);
    values.push(child);
    offset = child.end;
  }
  if (offset !== value.end) throw new Error("SAML signing certificate is invalid");
  return values;
}

function certificateSpki(certificate: string): Uint8Array {
  const bytes = base64Bytes(certificate, "SAML signing certificate", 16 * 1024);
  const outer = derValue(bytes, 0);
  if (outer.tag !== 0x30 || outer.end !== bytes.length) throw new Error("SAML signing certificate is invalid");
  const certificateParts = derChildren(bytes, outer);
  const tbs = certificateParts[0];
  if (certificateParts.length !== 3 || tbs?.tag !== 0x30) throw new Error("SAML signing certificate is invalid");
  const fields = derChildren(bytes, tbs);
  const versionOffset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const spki = fields[versionOffset + 5];
  if (spki?.tag !== 0x30) throw new Error("SAML signing certificate is invalid");
  return bytes.slice(spki.start, spki.end);
}

async function verifyWithPinnedCertificate(
  certificates: readonly string[],
  signature: Uint8Array,
  signedInfo: string,
): Promise<boolean> {
  for (const certificate of certificates) {
    try {
      const publicKey = await crypto.subtle.importKey(
        "spki",
        ownedBuffer(certificateSpki(certificate)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const algorithm = publicKey.algorithm as RsaHashedKeyAlgorithm;
      if (
        algorithm.modulusLength < 2048
        || algorithm.publicExponent.length !== 3
        || algorithm.publicExponent[0] !== 1
        || algorithm.publicExponent[1] !== 0
        || algorithm.publicExponent[2] !== 1
      ) continue;
      if (await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        ownedBuffer(signature),
        encoder.encode(signedInfo),
      )) return true;
    } catch {
      // Certificate rotation permits a bounded list; one malformed/old key never
      // bypasses verification and all candidates must fail before the assertion is rejected.
    }
  }
  return false;
}

function parseTimestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new Error(`SAML ${label} is invalid`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) throw new Error(`SAML ${label} is invalid`);
  return timestamp;
}

function attributeValues(assertion: XmlElement, name: string): string[] {
  const statements = elementChildren(assertion, SAML_ASSERTION, "AttributeStatement");
  const values: string[] = [];
  for (const statement of statements) {
    for (const item of elementChildren(statement, SAML_ASSERTION, "Attribute")) {
      if (attribute(item, "Name") !== name) continue;
      values.push(...elementChildren(item, SAML_ASSERTION, "AttributeValue").map((value) => text(value, 512)));
    }
  }
  return values;
}

function exactAttribute(assertion: XmlElement, name: string, label: string): string {
  const values = attributeValues(assertion, name);
  if (values.length !== 1 || values[0] === undefined) throw new Error(`SAML ${label} is missing or ambiguous`);
  return values[0];
}

export interface SamlAssertionVerification {
  readonly provider: HostedSamlProviderConfig;
  readonly identityIssuer: string;
  readonly audience: string;
  readonly acsUrl: string;
  readonly requestId: string;
  readonly now?: number;
}

export interface VerifiedSamlAssertion {
  readonly identity: HostedIdentity;
  readonly assertionId: string;
  readonly replayExpiresAt: number;
}

export function decodeSamlResponse(value: string): string {
  const bytes = base64Bytes(value, "SAML response");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("SAML response is not valid UTF-8");
  }
}

export async function verifySamlAssertion(
  xml: string,
  verification: SamlAssertionVerification,
): Promise<VerifiedSamlAssertion> {
  if (encoder.encode(xml).length > MAX_XML_BYTES) throw new Error("SAML response is too large");
  const now = verification.now ?? Date.now();
  const response = new StrictXmlParser(xml).parse();
  if (response.namespaceUri !== SAML_PROTOCOL || response.localName !== "Response") {
    throw new Error("SAML response root is invalid");
  }
  if (!constantTimeSamlValue(attribute(response, "Destination"), verification.acsUrl)) {
    throw new Error("SAML response destination is invalid");
  }
  if (!constantTimeSamlValue(attribute(response, "InResponseTo"), verification.requestId)) {
    throw new Error("SAML response request binding is invalid");
  }
  const responseIssuedAt = parseTimestamp(attribute(response, "IssueInstant"), "response issue time");
  if (responseIssuedAt > now + CLOCK_SKEW_MS || responseIssuedAt < now - MAX_ASSERTION_LIFETIME_MS) {
    throw new Error("SAML response issue time is invalid");
  }
  const responseIssuer = text(one(elementChildren(response, SAML_ASSERTION, "Issuer"), "response issuer"));
  if (!constantTimeSamlValue(responseIssuer, verification.provider.entityId)) throw new Error("SAML response issuer is invalid");
  const status = one(elementChildren(response, SAML_PROTOCOL, "Status"), "status");
  const statusCode = one(elementChildren(status, SAML_PROTOCOL, "StatusCode"), "status code");
  if (!constantTimeSamlValue(attribute(statusCode, "Value"), SUCCESS_STATUS)) throw new Error("SAML authentication was not successful");

  const assertion = one(elementChildren(response, SAML_ASSERTION, "Assertion"), "assertion");
  const assertionId = attribute(assertion, "ID");
  if (!/^_[A-Za-z0-9._:-]{8,255}$/u.test(assertionId)) throw new Error("SAML assertion ID is invalid");
  const idMatches = [response, ...descendants(response)].filter((element) =>
    element.attributes.some((item) => item.prefix === "" && new Set(["ID", "Id", "id"]).has(item.localName) && item.value === assertionId),
  );
  if (idMatches.length !== 1 || idMatches[0] !== assertion) throw new Error("SAML assertion ID is ambiguous");
  const allSignatures = [response, ...descendants(response)].filter(
    (element) => element.namespaceUri === XMLDSIG && element.localName === "Signature",
  );
  const signature = one(elementChildren(assertion, XMLDSIG, "Signature"), "assertion signature");
  if (allSignatures.length !== 1 || allSignatures[0] !== signature) {
    throw new Error("SAML assertion signature placement is invalid");
  }
  const signedInfo = one(elementChildren(signature, XMLDSIG, "SignedInfo"), "SignedInfo");
  const canonicalizationMethod = one(elementChildren(signedInfo, XMLDSIG, "CanonicalizationMethod"), "canonicalization method");
  if (attribute(canonicalizationMethod, "Algorithm") !== EXCLUSIVE_C14N || canonicalizationMethod.children.length !== 0) {
    throw new Error("SAML canonicalization algorithm is not allowed");
  }
  const signatureMethod = one(elementChildren(signedInfo, XMLDSIG, "SignatureMethod"), "signature method");
  if (attribute(signatureMethod, "Algorithm") !== RSA_SHA256) throw new Error("SAML signature algorithm is not allowed");
  const reference = one(elementChildren(signedInfo, XMLDSIG, "Reference"), "signature reference");
  if (!constantTimeSamlValue(attribute(reference, "URI"), `#${assertionId}`)) throw new Error("SAML signature reference is invalid");
  const transforms = one(elementChildren(reference, XMLDSIG, "Transforms"), "signature transforms");
  const transformAlgorithms = elementChildren(transforms, XMLDSIG, "Transform").map((transform) => attribute(transform, "Algorithm"));
  if (
    transformAlgorithms.length !== 2
    || transformAlgorithms[0] !== ENVELOPED_SIGNATURE
    || transformAlgorithms[1] !== EXCLUSIVE_C14N
  ) throw new Error("SAML signature transforms are not allowed");
  const digestMethod = one(elementChildren(reference, XMLDSIG, "DigestMethod"), "digest method");
  if (attribute(digestMethod, "Algorithm") !== SHA256) throw new Error("SAML digest algorithm is not allowed");
  const expectedDigest = base64Bytes(text(one(elementChildren(reference, XMLDSIG, "DigestValue"), "digest value")), "SAML digest", 64);
  if (expectedDigest.length !== 32) throw new Error("SAML digest is invalid");
  const actualDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalize(assertion, signature))));
  let digestDifference = expectedDigest.length ^ actualDigest.length;
  for (let index = 0; index < Math.max(expectedDigest.length, actualDigest.length); index += 1) {
    digestDifference |= (expectedDigest[index] ?? 0) ^ (actualDigest[index] ?? 0);
  }
  if (digestDifference !== 0) throw new Error("SAML assertion digest is invalid");
  const signatureValue = base64Bytes(
    text(one(elementChildren(signature, XMLDSIG, "SignatureValue"), "signature value")),
    "SAML signature",
    1024,
  );
  if (!await verifyWithPinnedCertificate(
    verification.provider.signingCertificates,
    signatureValue,
    canonicalize(signedInfo),
  )) throw new Error("SAML assertion signature is invalid");

  const assertionIssuer = text(one(elementChildren(assertion, SAML_ASSERTION, "Issuer"), "assertion issuer"));
  if (!constantTimeSamlValue(assertionIssuer, verification.provider.entityId)) throw new Error("SAML assertion issuer is invalid");
  const conditions = one(elementChildren(assertion, SAML_ASSERTION, "Conditions"), "conditions");
  const notBefore = parseTimestamp(attribute(conditions, "NotBefore"), "NotBefore");
  const notOnOrAfter = parseTimestamp(attribute(conditions, "NotOnOrAfter"), "NotOnOrAfter");
  if (
    notBefore > now + CLOCK_SKEW_MS
    || notOnOrAfter <= now - CLOCK_SKEW_MS
    || notOnOrAfter <= notBefore
    || notOnOrAfter - notBefore > MAX_ASSERTION_LIFETIME_MS
  ) throw new Error("SAML assertion is expired or has an invalid lifetime");
  const restrictions = elementChildren(conditions, SAML_ASSERTION, "AudienceRestriction");
  if (restrictions.length < 1 || restrictions.some((restriction) => {
    const audiences = elementChildren(restriction, SAML_ASSERTION, "Audience").map((audience) => text(audience));
    return audiences.length < 1 || !audiences.some((audience) => constantTimeSamlValue(audience, verification.audience));
  })) throw new Error("SAML assertion audience is invalid");

  const subject = one(elementChildren(assertion, SAML_ASSERTION, "Subject"), "subject");
  const nameId = one(elementChildren(subject, SAML_ASSERTION, "NameID"), "NameID");
  if (attribute(nameId, "Format") !== verification.provider.nameIdFormat) throw new Error("SAML NameID format is invalid");
  const rawSubject = text(nameId, 200);
  const confirmations = elementChildren(subject, SAML_ASSERTION, "SubjectConfirmation");
  if (confirmations.length !== 1 || confirmations[0] === undefined || attribute(confirmations[0], "Method") !== BEARER_CONFIRMATION) {
    throw new Error("SAML bearer subject confirmation is invalid");
  }
  const confirmationData = one(
    elementChildren(confirmations[0], SAML_ASSERTION, "SubjectConfirmationData"),
    "subject confirmation data",
  );
  if (
    !constantTimeSamlValue(attribute(confirmationData, "Recipient"), verification.acsUrl)
    || !constantTimeSamlValue(attribute(confirmationData, "InResponseTo"), verification.requestId)
  ) throw new Error("SAML subject confirmation binding is invalid");
  const confirmationExpiry = parseTimestamp(attribute(confirmationData, "NotOnOrAfter"), "subject confirmation expiry");
  const confirmationNotBeforeValue = optionalAttribute(confirmationData, "NotBefore");
  if (
    confirmationExpiry <= now - CLOCK_SKEW_MS
    || confirmationExpiry > notOnOrAfter + CLOCK_SKEW_MS
    || (confirmationNotBeforeValue !== null && parseTimestamp(confirmationNotBeforeValue, "subject confirmation NotBefore") > now + CLOCK_SKEW_MS)
  ) throw new Error("SAML subject confirmation is expired");

  const authn = one(elementChildren(assertion, SAML_ASSERTION, "AuthnStatement"), "authentication statement");
  const authenticatedAt = parseTimestamp(attribute(authn, "AuthnInstant"), "authentication instant");
  const sessionExpiryValue = optionalAttribute(authn, "SessionNotOnOrAfter");
  const sessionExpiry = sessionExpiryValue === null ? notOnOrAfter : parseTimestamp(sessionExpiryValue, "session expiry");
  if (authenticatedAt > now + CLOCK_SKEW_MS || authenticatedAt < now - MAX_ASSERTION_LIFETIME_MS || sessionExpiry <= now - CLOCK_SKEW_MS) {
    throw new Error("SAML authentication statement is invalid");
  }

  const assertedTenant = exactAttribute(assertion, verification.provider.tenantAttribute, "tenant attribute");
  if (!constantTimeSamlValue(assertedTenant, verification.provider.tenantId)) throw new Error("SAML tenant binding is invalid");
  const email = exactAttribute(assertion, verification.provider.emailAttribute, "email attribute").toLocaleLowerCase("en-US");
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) throw new Error("SAML email attribute is invalid");
  const displayName = verification.provider.displayNameAttribute === undefined
    ? email
    : exactAttribute(assertion, verification.provider.displayNameAttribute, "display name attribute");
  if (displayName.length > 100) throw new Error("SAML display name is invalid");
  const hostedSubject = `${verification.provider.tenantId}:${rawSubject}`;
  if (hostedSubject.length > 255) throw new Error("SAML tenant subject is too long");
  const expiresAt = Math.min(notOnOrAfter, confirmationExpiry, sessionExpiry);
  return {
    identity: {
      issuer: verification.identityIssuer,
      subject: hostedSubject,
      email,
      displayName,
      authenticatedAt,
      expiresAt,
    },
    assertionId,
    replayExpiresAt: expiresAt,
  };
}
