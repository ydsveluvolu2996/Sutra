export type DataCollectionMonitorOfficialCoverage =
  | "NATIVE_EXECUTION_EVIDENCE_PARTIAL"
  | "ABOUT";

export interface DataCollectionMonitorOfficialControl {
  readonly placement: "parameter" | "filter";
  readonly type: "List" | "Dropdown" | "Slider";
  readonly title: string;
  readonly nativeState: "SUPPORTED" | "SERVER_PINNED";
}

export interface DataCollectionMonitorOfficialSheet {
  readonly id: string;
  readonly name: string;
  readonly visualCount: number;
  readonly visualTypes: Readonly<Record<string, number>>;
  readonly controls: readonly DataCollectionMonitorOfficialControl[];
  readonly coverage: DataCollectionMonitorOfficialCoverage;
  readonly nativeAreas: readonly string[];
  readonly evidenceNote: string;
  readonly remainingGap: string;
}

const control = (
  placement: DataCollectionMonitorOfficialControl["placement"],
  type: DataCollectionMonitorOfficialControl["type"],
  title: string,
  nativeState: DataCollectionMonitorOfficialControl["nativeState"],
): DataCollectionMonitorOfficialControl => Object.freeze({
  placement, type, title, nativeState,
});

/**
 * Frozen audit of the public Data Collection Monitor v1.0.1 artifact.
 * The complete QuickSight definition is the dashboard `data` scalar embedded
 * in the manifest; there is no separate definition YAML at the pinned commit.
 */
export const DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION = Object.freeze({
  sourceRepository: "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  sourceCommit: "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  manifestPath: "dashboards/data-collection-monitor/data-collection-monitor.yaml",
  manifestSha256: "20412bfd4552f844d866e95ebeb9e42b7586ead1df82ef6da7d97234477d8a29",
  dashboardId: "dc-monitor",
  name: "Data Collection Monitor",
  version: "v1.0.1",
  theme: "MIDNIGHT",
  completeDefinitionPublished: true,
  standaloneDefinitionPath: null,
  changelogPath: null,
  dashboardSpecificDeploymentTemplatePath: null,
  artifacts: Object.freeze([
    Object.freeze({
      kind: "MANIFEST_CONTAINER",
      path: "dashboards/data-collection-monitor/data-collection-monitor.yaml",
      sha256: "20412bfd4552f844d866e95ebeb9e42b7586ead1df82ef6da7d97234477d8a29",
      hashBasis: "raw file bytes",
    }),
    Object.freeze({
      kind: "EMBEDDED_QUICKSIGHT_DEFINITION",
      path: "dashboards.DATA COLLECTION MONITOR.data",
      sha256: "0d4f19541870585d84e1df8ec2ac9bfbed5f42199c6d19fbe6c3104fa2f3e943",
      hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar",
    }),
    Object.freeze({
      kind: "EMBEDDED_DATASET_TEMPLATE",
      path: "datasets.data_collection_logs.data",
      sha256: "6e225a65e7c31a9337b8dc66256c5ab84a7035a0a863664e087c5c3956fadc10",
      hashBasis: "UTF-8 canonical JSON with recursively sorted object keys",
    }),
    Object.freeze({
      kind: "EMBEDDED_SQL_VIEW_QUERY",
      path: "views.data_collection_logs.data",
      sha256: "0bc9ff20a740dc1e2085e801443ede197f2b8c400ec92824f082fa1e07e0e6c9",
      hashBasis: "exact UTF-8 bytes of the decoded YAML block scalar",
    }),
  ]),
  datasetIdentifiers: Object.freeze(["Blank"]),
  datasetTemplateName: "data_collection_logs",
  viewName: "data_collection_logs",
  parameterNames: Object.freeze([
    "DaysWindow",
    "AccountID",
    "StatuscodeFamily",
    "StatusCodeBinary",
    "LogLinksMode",
  ]),
  totals: Object.freeze({
    sheets: 2,
    visuals: 10,
    parameterControls: 4,
    filterControls: 2,
    parameterDeclarations: 5,
    calculatedFields: 21,
    filterGroups: 15,
    columnConfigurations: 1,
    datasets: 1,
  }),
  visualTypes: Object.freeze({
    BarChartVisual: 2,
    TableVisual: 4,
    KPIVisual: 3,
    PivotTableVisual: 1,
  }),
  sheets: Object.freeze<readonly DataCollectionMonitorOfficialSheet[]>([
    Object.freeze({
      id: "fac3708e-284a-476a-9a4b-850dffd4a061",
      name: "Main",
      visualCount: 10,
      visualTypes: Object.freeze({
        BarChartVisual: 2,
        TableVisual: 4,
        KPIVisual: 3,
        PivotTableVisual: 1,
      }),
      controls: Object.freeze([
        control("parameter", "List", "Status Category", "SUPPORTED"),
        control("parameter", "List", "Log Links Mode", "SUPPORTED"),
        control("parameter", "Dropdown", "Account ID", "SERVER_PINNED"),
        control("parameter", "Slider", "Days back", "SUPPORTED"),
        control("filter", "Dropdown", "Module", "SUPPORTED"),
        control("filter", "Dropdown", "Payer ID", "SERVER_PINNED"),
      ]),
      coverage: "NATIVE_EXECUTION_EVIDENCE_PARTIAL",
      nativeAreas: Object.freeze([
        "module execution state",
        "success, error and running categories",
        "execution history",
        "retry counts",
        "latency",
        "record coverage",
        "validated Step Functions execution links",
      ]),
      evidenceNote: "Native views use normalized immutable Standard Step Functions execution telemetry; they do not assert downstream source truth.",
      remainingGap: "Payer and account scope remain server-pinned, raw parameters and log payloads are excluded, Lambda log links are unavailable, and QuickSight geometry is not reproduced.",
    }),
    Object.freeze({
      id: "dd87dca0-a7f5-41fe-8f2f-080c664ce532",
      name: "About",
      visualCount: 0,
      visualTypes: Object.freeze({}),
      controls: Object.freeze([]),
      coverage: "ABOUT",
      nativeAreas: Object.freeze([
        "immutable public artifact evidence",
        "collection state",
        "limitations",
        "source boundary disclosure",
      ]),
      evidenceNote: "The public artifact inventory and activation limitations remain visible even when instrumentation is unavailable.",
      remainingGap: "The embedded upstream About sheet contains zero visual objects; no screenshot or pixel-geometry inference is used.",
    }),
  ]),
});

export type DataCollectionMonitorOfficialDefinition =
  typeof DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION;
