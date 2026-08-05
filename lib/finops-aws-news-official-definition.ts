export interface AwsNewsOfficialVisual {
  readonly id: string;
  readonly type: string;
}

const visual = (id: string, type: string): AwsNewsOfficialVisual =>
  Object.freeze({ id, type });

/** Immutable audit of the QuickSight definition embedded in the AWS Feeds manifest. */
export const AWS_NEWS_OFFICIAL_DEFINITION = Object.freeze({
  source: Object.freeze({
    repository:
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
    commit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
    path: "dashboards/aws-feeds/aws-feeds.yaml",
    sha256: "1e3c569b4fe4100971a0c0c1530492745726408f58e9c5edd817895c516a4d6e",
    embeddedDefinitionSha256:
      "ac9bffb471fcf9730d765c45270ddc818c363ed8539c2d62f1df2da6f6115c4e",
    dashboardId: "aws-feeds",
    theme: "MIDNIGHT",
  }),
  totals: Object.freeze({
    sheets: 6,
    visuals: 21,
    parameterControls: 12,
    filterControls: 0,
    parameterDeclarations: 20,
    calculatedFields: 16,
    filterGroups: 20,
    columnConfigurations: 0,
    datasets: 5,
  }),
  visualTypes: Object.freeze({
    TableVisual: 7,
    BarChartVisual: 7,
    WordCloudVisual: 1,
    PivotTableVisual: 3,
    CustomContentVisual: 1,
    InsightVisual: 2,
  }),
  sheets: Object.freeze([
    Object.freeze({
      id: "59c9f319-c94c-408a-ba58-5724e0892243",
      name: "AWS Feeds Summary",
      controls: Object.freeze([
        "Start Date",
        "Category",
        "Feed Type",
        "Search Content",
      ]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      note: "Native family counts, bounded feed cards, categories, service relevance, search and publication timestamps; QuickSight bar/word-cloud/table geometry is not reproduced.",
      visuals: Object.freeze([
        visual("cce94b53-ea55-4308-966f-63ba797f9733", "TableVisual"),
        visual("2d7a4a7e-1264-4682-82af-27beadb80b24", "BarChartVisual"),
        visual("9262e355-372c-4483-a381-979a19f2a790", "WordCloudVisual"),
        visual("e52806f8-4bd8-4711-9b76-cc01b57ebd38", "BarChartVisual"),
        visual("107983c4-dbfb-4058-af7d-a8a666b7d417", "TableVisual"),
      ]),
    }),
    Object.freeze({
      id: "86bfd032-66cc-464c-90ed-c3160fff062e",
      name: "AWS What's New",
      controls: Object.freeze(["Category", "Service", "Search Content"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      note: "Native What's New items, exact service/category/search controls and safe official links; pivot/bar geometry remains partial.",
      visuals: Object.freeze([
        visual("320db2f3-fc02-4292-a078-6109c3e6d697", "BarChartVisual"),
        visual("c83e2e7a-d80c-4cfc-9689-ea0b83813a17", "PivotTableVisual"),
        visual("11e3f62f-0673-4885-a7d4-7aa8e7ef564f", "TableVisual"),
        visual("ab9f2994-60c0-4483-a315-5ec0423b511f", "BarChartVisual"),
      ]),
    }),
    Object.freeze({
      id: "262f8d75-3a13-4712-8a96-89f420e19ee2",
      name: "AWS Blog Posts",
      controls: Object.freeze(["Author", "Category", "Search Content"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      note: "Native AWS News Blog items plus supplemental Security Blog source; author is not normalized, and pivot/bar geometry remains partial.",
      visuals: Object.freeze([
        visual("45ce6573-a74c-4131-ae13-24b377e49162", "BarChartVisual"),
        visual("8a97b9f5-4536-434b-b56c-81ca359b70e9", "PivotTableVisual"),
        visual("343358e8-fa67-44f5-b630-3b93364748d9", "BarChartVisual"),
        visual("7f4f854a-61e9-4f52-a4d0-486d4cf0c550", "TableVisual"),
      ]),
    }),
    Object.freeze({
      id: "05b4f2ce-535c-4728-aeca-2c0ede09c064",
      name: "AWS YouTube Videos",
      controls: Object.freeze(["Search Content"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      note: "Native official-channel video metadata and safe watch links; arbitrary embedded custom content is deliberately not reproduced.",
      visuals: Object.freeze([
        visual("159a08e0-8756-4cb1-868b-112db183b551", "TableVisual"),
        visual("b96ef4e1-3dfd-4154-a77a-7460ae9edfab", "CustomContentVisual"),
        visual("b7ce1c11-f67d-4d2a-9c97-9b95d8ef5642", "TableVisual"),
      ]),
    }),
    Object.freeze({
      id: "ab1a458b-24c2-4afb-a455-43189a21c614",
      name: "AWS Security Bulletin",
      controls: Object.freeze(["Search Content"]),
      coverage: "NATIVE_EVIDENCE_PARTIAL",
      note: "Native official bulletin items and provider-authored classifications; pivot/bar geometry remains partial.",
      visuals: Object.freeze([
        visual("141757cb-4396-4b1a-a958-2f3c48e7b41e", "PivotTableVisual"),
        visual("4bedb8e3-5df5-4900-ac93-358f82f342fa", "TableVisual"),
        visual("3d66fd88-dab9-49aa-aab3-c5dc13dadfab", "BarChartVisual"),
      ]),
    }),
    Object.freeze({
      id: "ec103200-c279-4a69-bdfe-9b3075e1e22b",
      name: "About",
      controls: Object.freeze([]),
      coverage: "ABOUT_EVIDENCE",
      note: "Native immutable source, freshness, collection state, evidence identifiers and limitations.",
      visuals: Object.freeze([
        visual("20547a2d-aadc-4a62-964a-a9b2532be5bd", "InsightVisual"),
        visual("bc271d34-23cf-4b98-a75f-07d4f0139a22", "InsightVisual"),
      ]),
    }),
  ]),
  disclosures: Object.freeze([
    "Exact object counts describe the pinned AWS QuickSight definition, not pixel or interaction parity.",
    "Public announcements are contextual intelligence and never prove tenant impact.",
    "Security Blog is a supplemental official source; the pinned definition models the AWS Blog Posts family rather than a separate Security Blog sheet.",
  ]),
} as const);

export type AwsNewsOfficialDefinition = typeof AWS_NEWS_OFFICIAL_DEFINITION;
