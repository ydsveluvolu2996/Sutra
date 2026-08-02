/**
 * Exact, pure allowlists for AWS Compute Optimizer recommendation exports.
 *
 * The operation API reference `fieldsToExport` Valid Values are authoritative.
 * The user-guide export table is supporting evidence only: it currently has a
 * few casing, plurality, spelling, and invisible-character discrepancies.
 */

import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportOperation,
} from "./finops-compute-optimizer-export-plan";

const FIELD = /^[A-Za-z][A-Za-z0-9]{0,127}$/u;

const OPERATION_BY_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, ComputeOptimizerExportOperation>
> = Object.freeze({
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  AUTO_SCALING_GROUP: "ExportAutoScalingGroupRecommendations",
  EBS_VOLUME: "ExportEBSVolumeRecommendations",
  LAMBDA_FUNCTION: "ExportLambdaFunctionRecommendations",
  ECS_SERVICE: "ExportECSServiceRecommendations",
  LICENSE: "ExportLicenseRecommendations",
  RDS_DATABASE: "ExportRDSDatabaseRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
});

export const COMPUTE_OPTIMIZER_EXPORT_FAMILIES = Object.freeze(
  Object.keys(OPERATION_BY_FAMILY) as ComputeOptimizerExportFamily[],
);

export type ComputeOptimizerMapperCapability =
  | "identity"
  | "finding"
  | "refresh"
  | "configuration"
  | "risk"
  | "savings"
  | "tags";

export interface ComputeOptimizerCapabilityProjection {
  readonly supported: boolean;
  readonly fields: readonly string[];
}

export interface ComputeOptimizerExportFieldCatalogEntry {
  readonly operation: ComputeOptimizerExportOperation;
  readonly fieldsToExport: readonly string[];
  readonly minimumProjection: readonly string[];
  readonly capabilityProjection: Readonly<
    Record<ComputeOptimizerMapperCapability, ComputeOptimizerCapabilityProjection>
  >;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fields(source: string): readonly string[] {
  const values = source.trim().split(/\s+/u);
  if (
    values.length === 0
    || values.some((value) => !FIELD.test(value))
    || new Set(values).size !== values.length
  ) {
    throw new Error("Invalid embedded Compute Optimizer field catalog");
  }
  return Object.freeze(values.sort(compareCodePoints));
}

function capability(supported: boolean, source = ""): ComputeOptimizerCapabilityProjection {
  const values = source === "" ? Object.freeze([]) : fields(source);
  if (supported !== (values.length > 0)) {
    throw new Error("Invalid embedded Compute Optimizer capability projection");
  }
  return Object.freeze({ supported, fields: values });
}

function entry(
  family: ComputeOptimizerExportFamily,
  allowlistSource: string,
  projection: Record<ComputeOptimizerMapperCapability, ComputeOptimizerCapabilityProjection>,
): ComputeOptimizerExportFieldCatalogEntry {
  const allowlist = fields(allowlistSource);
  const allowed = new Set(allowlist);
  const capabilityProjection = Object.freeze({ ...projection });
  const minimumProjection = Object.freeze(
    [...new Set(
      Object.values(capabilityProjection).flatMap((value) => value.fields),
    )].sort(compareCodePoints),
  );
  if (minimumProjection.some((value) => !allowed.has(value))) {
    throw new Error("Capability projection is outside its Compute Optimizer allowlist");
  }
  return Object.freeze({
    operation: OPERATION_BY_FAMILY[family],
    fieldsToExport: allowlist,
    minimumProjection,
    capabilityProjection,
  });
}

export const COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG: Readonly<
  Record<ComputeOptimizerExportFamily, ComputeOptimizerExportFieldCatalogEntry>
> = Object.freeze({
  EC2_INSTANCE: entry(
    "EC2_INSTANCE",
    `
      AccountId CurrentInstanceGpuInfo CurrentInstanceType CurrentMemory
      CurrentNetwork CurrentOnDemandPrice CurrentPerformanceRisk CurrentStandardOneYearNoUpfrontReservedPrice
      CurrentStandardThreeYearNoUpfrontReservedPrice CurrentStorage CurrentVCpus EffectiveRecommendationPreferencesCpuVendorArchitectures
      EffectiveRecommendationPreferencesEnhancedInfrastructureMetrics EffectiveRecommendationPreferencesExternalMetricsSource EffectiveRecommendationPreferencesInferredWorkloadTypes EffectiveRecommendationPreferencesLookBackPeriod
      EffectiveRecommendationPreferencesPreferredResources EffectiveRecommendationPreferencesSavingsEstimationMode EffectiveRecommendationPreferencesUtilizationPreferences ExternalMetricStatusCode
      ExternalMetricStatusReason Finding FindingReasonCodes Idle
      InferredWorkloadTypes InstanceArn InstanceName InstanceState
      LastRefreshTimestamp LookbackPeriodInDays RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts
      RecommendationOptionsEstimatedMonthlySavingsValue RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts RecommendationOptionsInstanceGpuInfo RecommendationOptionsInstanceType
      RecommendationOptionsMemory RecommendationOptionsMigrationEffort RecommendationOptionsNetwork RecommendationOptionsOnDemandPrice
      RecommendationOptionsPerformanceRisk RecommendationOptionsPlatformDifferences RecommendationOptionsProjectedUtilizationMetricsCpuMaximum RecommendationOptionsProjectedUtilizationMetricsGpuMemoryPercentageMaximum
      RecommendationOptionsProjectedUtilizationMetricsGpuPercentageMaximum RecommendationOptionsProjectedUtilizationMetricsMemoryMaximum RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage RecommendationOptionsSavingsOpportunityPercentage
      RecommendationOptionsStandardOneYearNoUpfrontReservedPrice RecommendationOptionsStandardThreeYearNoUpfrontReservedPrice RecommendationOptionsStorage RecommendationOptionsVcpus
      RecommendationsSourcesRecommendationSourceArn RecommendationsSourcesRecommendationSourceType Tags UtilizationMetricsCpuMaximum
      UtilizationMetricsDiskReadBytesPerSecondMaximum UtilizationMetricsDiskReadOpsPerSecondMaximum UtilizationMetricsDiskWriteBytesPerSecondMaximum UtilizationMetricsDiskWriteOpsPerSecondMaximum
      UtilizationMetricsEbsReadBytesPerSecondMaximum UtilizationMetricsEbsReadOpsPerSecondMaximum UtilizationMetricsEbsWriteBytesPerSecondMaximum UtilizationMetricsEbsWriteOpsPerSecondMaximum
      UtilizationMetricsGpuMemoryPercentageMaximum UtilizationMetricsGpuPercentageMaximum UtilizationMetricsMemoryMaximum UtilizationMetricsNetworkInBytesPerSecondMaximum
      UtilizationMetricsNetworkOutBytesPerSecondMaximum UtilizationMetricsNetworkPacketsInPerSecondMaximum UtilizationMetricsNetworkPacketsOutPerSecondMaximum
    `,
    {
      identity: capability(true, "AccountId InstanceArn"),
      finding: capability(true, "Finding FindingReasonCodes"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, "CurrentInstanceType RecommendationOptionsInstanceType"),
      risk: capability(true, "CurrentPerformanceRisk RecommendationOptionsPerformanceRisk"),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  AUTO_SCALING_GROUP: entry(
    "AUTO_SCALING_GROUP",
    `
      AccountId AutoScalingGroupArn AutoScalingGroupName CurrentConfigurationAllocationStrategy
      CurrentConfigurationDesiredCapacity CurrentConfigurationInstanceType CurrentConfigurationMaxSize CurrentConfigurationMinSize
      CurrentConfigurationMixedInstanceTypes CurrentConfigurationType CurrentInstanceGpuInfo CurrentMemory
      CurrentNetwork CurrentOnDemandPrice CurrentPerformanceRisk CurrentStandardOneYearNoUpfrontReservedPrice
      CurrentStandardThreeYearNoUpfrontReservedPrice CurrentStorage CurrentVCpus EffectiveRecommendationPreferencesCpuVendorArchitectures
      EffectiveRecommendationPreferencesEnhancedInfrastructureMetrics EffectiveRecommendationPreferencesInferredWorkloadTypes EffectiveRecommendationPreferencesLookBackPeriod EffectiveRecommendationPreferencesPreferredResources
      EffectiveRecommendationPreferencesSavingsEstimationMode Finding InferredWorkloadTypes LastRefreshTimestamp
      LookbackPeriodInDays RecommendationOptionsConfigurationAllocationStrategy RecommendationOptionsConfigurationDesiredCapacity RecommendationOptionsConfigurationEstimatedInstanceHourReductionPercentage
      RecommendationOptionsConfigurationInstanceType RecommendationOptionsConfigurationMaxSize RecommendationOptionsConfigurationMinSize RecommendationOptionsConfigurationMixedInstanceTypes
      RecommendationOptionsConfigurationType RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts RecommendationOptionsEstimatedMonthlySavingsValue
      RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts RecommendationOptionsInstanceGpuInfo RecommendationOptionsMemory RecommendationOptionsMigrationEffort
      RecommendationOptionsNetwork RecommendationOptionsOnDemandPrice RecommendationOptionsPerformanceRisk RecommendationOptionsProjectedUtilizationMetricsCpuMaximum
      RecommendationOptionsProjectedUtilizationMetricsGpuMemoryPercentageMaximum RecommendationOptionsProjectedUtilizationMetricsGpuPercentageMaximum RecommendationOptionsProjectedUtilizationMetricsMemoryMaximum RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage
      RecommendationOptionsSavingsOpportunityPercentage RecommendationOptionsStandardOneYearNoUpfrontReservedPrice RecommendationOptionsStandardThreeYearNoUpfrontReservedPrice RecommendationOptionsStorage
      RecommendationOptionsVcpus UtilizationMetricsCpuMaximum UtilizationMetricsDiskReadBytesPerSecondMaximum UtilizationMetricsDiskReadOpsPerSecondMaximum
      UtilizationMetricsDiskWriteBytesPerSecondMaximum UtilizationMetricsDiskWriteOpsPerSecondMaximum UtilizationMetricsEbsReadBytesPerSecondMaximum UtilizationMetricsEbsReadOpsPerSecondMaximum
      UtilizationMetricsEbsWriteBytesPerSecondMaximum UtilizationMetricsEbsWriteOpsPerSecondMaximum UtilizationMetricsGpuMemoryPercentageMaximum UtilizationMetricsGpuPercentageMaximum
      UtilizationMetricsMemoryMaximum UtilizationMetricsNetworkInBytesPerSecondMaximum UtilizationMetricsNetworkOutBytesPerSecondMaximum UtilizationMetricsNetworkPacketsInPerSecondMaximum
      UtilizationMetricsNetworkPacketsOutPerSecondMaximum
    `,
    {
      identity: capability(true, "AccountId AutoScalingGroupArn AutoScalingGroupName"),
      finding: capability(true, "Finding"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        CurrentConfigurationDesiredCapacity CurrentConfigurationInstanceType
        RecommendationOptionsConfigurationDesiredCapacity RecommendationOptionsConfigurationInstanceType
      `),
      risk: capability(true, "CurrentPerformanceRisk RecommendationOptionsPerformanceRisk"),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(false),
    },
  ),
  EBS_VOLUME: entry(
    "EBS_VOLUME",
    `
      AccountId CurrentConfigurationRootVolume CurrentConfigurationVolumeBaselineIOPS CurrentConfigurationVolumeBaselineThroughput
      CurrentConfigurationVolumeBurstIOPS CurrentConfigurationVolumeBurstThroughput CurrentConfigurationVolumeSize CurrentConfigurationVolumeType
      CurrentMonthlyPrice CurrentPerformanceRisk EffectiveRecommendationPreferencesLookBackPeriod EffectiveRecommendationPreferencesSavingsEstimationMode
      Finding LastRefreshTimestamp LookbackPeriodInDays RecommendationOptionsConfigurationVolumeBaselineIOPS
      RecommendationOptionsConfigurationVolumeBaselineThroughput RecommendationOptionsConfigurationVolumeBurstIOPS RecommendationOptionsConfigurationVolumeBurstThroughput RecommendationOptionsConfigurationVolumeSize
      RecommendationOptionsConfigurationVolumeType RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts RecommendationOptionsEstimatedMonthlySavingsValue
      RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts RecommendationOptionsMonthlyPrice RecommendationOptionsPerformanceRisk RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage
      RecommendationOptionsSavingsOpportunityPercentage RootVolume Tags UtilizationMetricsVolumeIOPSExceededMaximum
      UtilizationMetricsVolumeReadBytesPerSecondMaximum UtilizationMetricsVolumeReadOpsPerSecondMaximum UtilizationMetricsVolumeThroughputExceededMaximum UtilizationMetricsVolumeWriteBytesPerSecondMaximum
      UtilizationMetricsVolumeWriteOpsPerSecondMaximum VolumeArn
    `,
    {
      identity: capability(true, "AccountId VolumeArn"),
      finding: capability(true, "Finding"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        CurrentConfigurationVolumeBaselineIOPS CurrentConfigurationVolumeBaselineThroughput
        CurrentConfigurationVolumeSize CurrentConfigurationVolumeType
        RecommendationOptionsConfigurationVolumeBaselineIOPS
        RecommendationOptionsConfigurationVolumeBaselineThroughput
        RecommendationOptionsConfigurationVolumeSize RecommendationOptionsConfigurationVolumeType
      `),
      risk: capability(true, "CurrentPerformanceRisk RecommendationOptionsPerformanceRisk"),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  LAMBDA_FUNCTION: entry(
    "LAMBDA_FUNCTION",
    `
      AccountId CurrentConfigurationMemorySize CurrentConfigurationTimeout CurrentCostAverage
      CurrentCostTotal CurrentPerformanceRisk EffectiveRecommendationPreferencesSavingsEstimationMode Finding
      FindingReasonCodes FunctionArn FunctionVersion LastRefreshTimestamp
      LookbackPeriodInDays NumberOfInvocations RecommendationOptionsConfigurationMemorySize RecommendationOptionsCostHigh
      RecommendationOptionsCostLow RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts RecommendationOptionsEstimatedMonthlySavingsValue
      RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts RecommendationOptionsProjectedUtilizationMetricsDurationExpected RecommendationOptionsProjectedUtilizationMetricsDurationLowerBound RecommendationOptionsProjectedUtilizationMetricsDurationUpperBound
      RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage RecommendationOptionsSavingsOpportunityPercentage Tags UtilizationMetricsDurationAverage
      UtilizationMetricsDurationMaximum UtilizationMetricsMemoryAverage UtilizationMetricsMemoryMaximum
    `,
    {
      identity: capability(true, "AccountId FunctionArn FunctionVersion"),
      finding: capability(true, "Finding FindingReasonCodes"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        CurrentConfigurationMemorySize CurrentConfigurationTimeout
        RecommendationOptionsConfigurationMemorySize
      `),
      risk: capability(true, "CurrentPerformanceRisk"),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  ECS_SERVICE: entry(
    "ECS_SERVICE",
    `
      AccountId CurrentPerformanceRisk CurrentServiceConfigurationAutoScalingConfiguration CurrentServiceConfigurationCpu
      CurrentServiceConfigurationMemory CurrentServiceConfigurationTaskDefinitionArn CurrentServiceContainerConfigurations EffectiveRecommendationPreferencesLookBackPeriod
      EffectiveRecommendationPreferencesSavingsEstimationMode Finding FindingReasonCodes LastRefreshTimestamp
      LaunchType LookbackPeriodInDays RecommendationOptionsContainerRecommendations RecommendationOptionsCpu
      RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts RecommendationOptionsEstimatedMonthlySavingsValue RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts
      RecommendationOptionsMemory RecommendationOptionsProjectedUtilizationMetricsCpuMaximum RecommendationOptionsProjectedUtilizationMetricsMemoryMaximum RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage
      RecommendationOptionsSavingsOpportunityPercentage ServiceArn Tags UtilizationMetricsCpuMaximum
      UtilizationMetricsMemoryMaximum
    `,
    {
      identity: capability(true, "AccountId ServiceArn"),
      finding: capability(true, "Finding FindingReasonCodes"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        CurrentServiceConfigurationCpu CurrentServiceConfigurationMemory
        CurrentServiceConfigurationTaskDefinitionArn LaunchType
        RecommendationOptionsCpu RecommendationOptionsMemory
      `),
      risk: capability(true, "CurrentPerformanceRisk"),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  LICENSE: entry(
    "LICENSE",
    `
      AccountId CurrentLicenseConfigurationInstanceType CurrentLicenseConfigurationLicenseEdition CurrentLicenseConfigurationLicenseModel
      CurrentLicenseConfigurationLicenseName CurrentLicenseConfigurationLicenseVersion CurrentLicenseConfigurationMetricsSource CurrentLicenseConfigurationNumberOfCores
      CurrentLicenseConfigurationOperatingSystem Finding FindingReasonCodes LastRefreshTimestamp
      LookbackPeriodInDays RecommendationOptionsEstimatedMonthlySavingsCurrency RecommendationOptionsEstimatedMonthlySavingsValue RecommendationOptionsLicenseEdition
      RecommendationOptionsLicenseModel RecommendationOptionsOperatingSystem RecommendationOptionsSavingsOpportunityPercentage ResourceArn
      Tags
    `,
    {
      identity: capability(true, "AccountId ResourceArn"),
      finding: capability(true, "Finding FindingReasonCodes"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        CurrentLicenseConfigurationInstanceType CurrentLicenseConfigurationLicenseEdition
        CurrentLicenseConfigurationLicenseModel CurrentLicenseConfigurationLicenseName
        CurrentLicenseConfigurationLicenseVersion CurrentLicenseConfigurationNumberOfCores
        CurrentLicenseConfigurationOperatingSystem RecommendationOptionsLicenseEdition
        RecommendationOptionsLicenseModel RecommendationOptionsOperatingSystem
      `),
      risk: capability(false),
      savings: capability(true, `
        RecommendationOptionsEstimatedMonthlySavingsCurrency
        RecommendationOptionsEstimatedMonthlySavingsValue
        RecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  RDS_DATABASE: entry(
    "RDS_DATABASE",
    `
      AccountId ClusterWriter CurrentDBInstanceClass CurrentInstanceOnDemandHourlyPrice
      CurrentInstancePerformanceRisk CurrentStorageConfigurationAllocatedStorage CurrentStorageConfigurationIOPS CurrentStorageConfigurationMaxAllocatedStorage
      CurrentStorageConfigurationStorageThroughput CurrentStorageConfigurationStorageType CurrentStorageEstimatedClusterInstanceOnDemandMonthlyCost CurrentStorageEstimatedClusterStorageIOOnDemandMonthlyCost
      CurrentStorageEstimatedClusterStorageOnDemandMonthlyCost CurrentStorageEstimatedMonthlyVolumeIOPsCostVariation CurrentStorageOnDemandMonthlyPrice DBClusterIdentifier
      EffectiveRecommendationPreferencesCpuVendorArchitectures EffectiveRecommendationPreferencesEnhancedInfrastructureMetrics EffectiveRecommendationPreferencesLookBackPeriod EffectiveRecommendationPreferencesSavingsEstimationMode
      Engine EngineVersion Idle InstanceFinding
      InstanceFindingReasonCodes InstanceRecommendationOptionsDBInstanceClass InstanceRecommendationOptionsEstimatedMonthlySavingsCurrency InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts
      InstanceRecommendationOptionsEstimatedMonthlySavingsValue InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts InstanceRecommendationOptionsInstanceOnDemandHourlyPrice InstanceRecommendationOptionsPerformanceRisk
      InstanceRecommendationOptionsProjectedUtilizationMetricsCpuMaximum InstanceRecommendationOptionsRank InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage InstanceRecommendationOptionsSavingsOpportunityPercentage
      LastRefreshTimestamp LookbackPeriodInDays MultiAZDBInstance PromotionTier
      ResourceArn StorageFinding StorageFindingReasonCodes StorageRecommendationOptionsAllocatedStorage
      StorageRecommendationOptionsEstimatedClusterInstanceOnDemandMonthlyCost StorageRecommendationOptionsEstimatedClusterStorageIOOnDemandMonthlyCost StorageRecommendationOptionsEstimatedClusterStorageOnDemandMonthlyCost StorageRecommendationOptionsEstimatedMonthlySavingsCurrency
      StorageRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts StorageRecommendationOptionsEstimatedMonthlySavingsValue StorageRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts StorageRecommendationOptionsEstimatedMonthlyVolumeIOPsCostVariation
      StorageRecommendationOptionsIOPS StorageRecommendationOptionsMaxAllocatedStorage StorageRecommendationOptionsOnDemandMonthlyPrice StorageRecommendationOptionsRank
      StorageRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage StorageRecommendationOptionsSavingsOpportunityPercentage StorageRecommendationOptionsStorageThroughput StorageRecommendationOptionsStorageType
      Tags UtilizationMetricsAuroraMemoryHealthStateMaximum UtilizationMetricsAuroraMemoryNumDeclinedSqlTotalMaximum UtilizationMetricsAuroraMemoryNumKillConnTotalMaximum
      UtilizationMetricsAuroraMemoryNumKillQueryTotalMaximum UtilizationMetricsCpuMaximum UtilizationMetricsDatabaseConnectionsMaximum UtilizationMetricsEBSVolumeReadIOPSMaximum
      UtilizationMetricsEBSVolumeReadThroughputMaximum UtilizationMetricsEBSVolumeStorageSpaceUtilizationMaximum UtilizationMetricsEBSVolumeWriteIOPSMaximum UtilizationMetricsEBSVolumeWriteThroughputMaximum
      UtilizationMetricsMemoryMaximum UtilizationMetricsNetworkReceiveThroughputMaximum UtilizationMetricsNetworkTransmitThroughputMaximum UtilizationMetricsReadIOPSEphemeralStorageMaximum
      UtilizationMetricsStorageNetworkReceiveThroughputMaximum UtilizationMetricsStorageNetworkTransmitThroughputMaximum UtilizationMetricsVolumeBytesUsedAverage UtilizationMetricsVolumeReadIOPsAverage
      UtilizationMetricsVolumeWriteIOPsAverage UtilizationMetricsWriteIOPSEphemeralStorageMaximum
    `,
    {
      identity: capability(true, "AccountId DBClusterIdentifier ResourceArn"),
      finding: capability(true, `
        InstanceFinding InstanceFindingReasonCodes StorageFinding StorageFindingReasonCodes
      `),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(true, `
        ClusterWriter CurrentDBInstanceClass CurrentStorageConfigurationAllocatedStorage
        CurrentStorageConfigurationIOPS CurrentStorageConfigurationMaxAllocatedStorage
        CurrentStorageConfigurationStorageThroughput CurrentStorageConfigurationStorageType
        Engine EngineVersion InstanceRecommendationOptionsDBInstanceClass MultiAZDBInstance PromotionTier
        StorageRecommendationOptionsAllocatedStorage StorageRecommendationOptionsIOPS
        StorageRecommendationOptionsMaxAllocatedStorage StorageRecommendationOptionsStorageThroughput
        StorageRecommendationOptionsStorageType
      `),
      risk: capability(true, `
        CurrentInstancePerformanceRisk InstanceRecommendationOptionsPerformanceRisk
      `),
      savings: capability(true, `
        InstanceRecommendationOptionsEstimatedMonthlySavingsCurrency
        InstanceRecommendationOptionsEstimatedMonthlySavingsValue
        InstanceRecommendationOptionsSavingsOpportunityPercentage
        StorageRecommendationOptionsEstimatedMonthlySavingsCurrency
        StorageRecommendationOptionsEstimatedMonthlySavingsValue
        StorageRecommendationOptionsSavingsOpportunityPercentage
      `),
      tags: capability(true, "Tags"),
    },
  ),
  IDLE_RESOURCE: entry(
    "IDLE_RESOURCE",
    `
      AccountId Finding FindingDescription LastRefreshTimestamp
      LookbackPeriodInDays ResourceArn ResourceId ResourceType
      SavingsOpportunity SavingsOpportunityAfterDiscount Tags UtilizationMetricsActiveConnectionCountMaximum
      UtilizationMetricsCacheHitsSum UtilizationMetricsCacheMissesSum UtilizationMetricsConsumedReadCapacityUnitsSum UtilizationMetricsConsumedWriteCapacityUnitsSum
      UtilizationMetricsCpuMaximum UtilizationMetricsCurrConnectionsSum UtilizationMetricsDatabaseConnectionsMaximum UtilizationMetricsDatabaseConnectionsSum
      UtilizationMetricsEBSVolumeReadIOPSMaximum UtilizationMetricsEBSVolumeWriteIOPSMaximum UtilizationMetricsElastiCacheProcessingUnitsSum UtilizationMetricsEngineCPUUtilizationMaximum
      UtilizationMetricsGetTypeCmdsSum UtilizationMetricsInvocationsSum UtilizationMetricsIsIdleMinimum UtilizationMetricsKeyspaceHitsSum
      UtilizationMetricsKeyspaceMissesSum UtilizationMetricsMemoryMaximum UtilizationMetricsNetworkInBytesPerSecondMaximum UtilizationMetricsNetworkOutBytesPerSecondMaximum
      UtilizationMetricsNewConnectionsSum UtilizationMetricsPacketsInFromDestinationMaximum UtilizationMetricsPacketsInFromSourceMaximum UtilizationMetricsSetTypeCmdsSum
      UtilizationMetricsUserConnectedSum UtilizationMetricsVolumeReadOpsPerSecondMaximum UtilizationMetricsVolumeWriteOpsPerSecondMaximum
    `,
    {
      identity: capability(true, "AccountId ResourceArn ResourceId ResourceType"),
      finding: capability(true, "Finding FindingDescription"),
      refresh: capability(true, "LastRefreshTimestamp"),
      configuration: capability(false),
      risk: capability(false),
      savings: capability(true, "SavingsOpportunity SavingsOpportunityAfterDiscount"),
      tags: capability(true, "Tags"),
    },
  ),
});

/**
 * The single server-owned projection used for new export materializations.
 *
 * `minimumProjection` remains the capability floor accepted by the immutable
 * plan verifier. This projection additionally pins fields that the mapper
 * requires for temporal evidence and independently retained discount/rank
 * channels. Keeping the union here prevents launch and mapping contracts from
 * evolving independently.
 */
function materializationProjection(
  family: ComputeOptimizerExportFamily,
): readonly string[] {
  const additions = ["LookbackPeriodInDays"];
  if (["EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION", "ECS_SERVICE"]
    .includes(family)) {
    additions.push(
      "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    );
  }
  if (family === "RDS_DATABASE") {
    additions.push(
      "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "InstanceRecommendationOptionsRank",
      "InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
      "StorageRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "StorageRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "StorageRecommendationOptionsRank",
      "StorageRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    );
  }
  const catalog = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family];
  const result = [...new Set([...catalog.minimumProjection, ...additions])]
    .sort(compareCodePoints);
  if (result.some((value) => !catalog.fieldsToExport.includes(value))) {
    throw new Error("Materialization projection is outside its Compute Optimizer allowlist");
  }
  return Object.freeze(result);
}

export const COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION: Readonly<
  Record<ComputeOptimizerExportFamily, readonly string[]>
> = Object.freeze({
  EC2_INSTANCE: materializationProjection("EC2_INSTANCE"),
  AUTO_SCALING_GROUP: materializationProjection("AUTO_SCALING_GROUP"),
  EBS_VOLUME: materializationProjection("EBS_VOLUME"),
  LAMBDA_FUNCTION: materializationProjection("LAMBDA_FUNCTION"),
  ECS_SERVICE: materializationProjection("ECS_SERVICE"),
  LICENSE: materializationProjection("LICENSE"),
  RDS_DATABASE: materializationProjection("RDS_DATABASE"),
  IDLE_RESOURCE: materializationProjection("IDLE_RESOURCE"),
});

export const COMPUTE_OPTIMIZER_EXPORT_FIELD_EVIDENCE = Object.freeze({
  retrievedOn: "2026-08-02",
  authority: "AWS Compute Optimizer API Reference fieldsToExport Valid Values",
  userGuideUrl:
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/exported-files.html",
  apiReferenceByFamily: Object.freeze({
    EC2_INSTANCE:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportEC2InstanceRecommendations.html",
    AUTO_SCALING_GROUP:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportAutoScalingGroupRecommendations.html",
    EBS_VOLUME:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportEBSVolumeRecommendations.html",
    LAMBDA_FUNCTION:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportLambdaFunctionRecommendations.html",
    ECS_SERVICE:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportECSServiceRecommendations.html",
    LICENSE:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportLicenseRecommendations.html",
    RDS_DATABASE:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportRDSDatabaseRecommendations.html",
    IDLE_RESOURCE:
      "https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportIdleRecommendations.html",
  }),
  resolutionPolicy:
    "Use each operation API reference Valid Values verbatim; do not derive request fields from CSV labels.",
  documentedDiscrepancies: Object.freeze([
    "The user guide uses plural Findings for some list sections; the operation APIs use Finding.",
    "The user guide shows ResourceID for idle resources; the operation API uses ResourceId.",
    "The user guide abbreviates or misspells several RDS utilization fields; the operation API values are canonical.",
    "Auto Scaling group exports do not currently expose Tags in their operation allowlist.",
    "License and idle exports do not currently expose an explicit performance-risk field.",
  ]),
} as const);

export class ComputeOptimizerExportFieldCatalogError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_EXPORT_FAMILY"
      | "OPERATION_MISMATCH"
      | "INVALID_FIELDS"
      | "DUPLICATE_FIELD"
      | "NON_CANONICAL_ORDER"
      | "UNKNOWN_FIELD"
      | "CROSS_FAMILY_FIELD"
      | "MINIMUM_FIELD_MISSING",
  ) {
    super("Compute Optimizer fieldsToExport rejected");
    this.name = "ComputeOptimizerExportFieldCatalogError";
  }
}

function reject(code: ComputeOptimizerExportFieldCatalogError["code"]): never {
  throw new ComputeOptimizerExportFieldCatalogError(code);
}

function isExportFamily(value: unknown): value is ComputeOptimizerExportFamily {
  return typeof value === "string" && Object.hasOwn(OPERATION_BY_FAMILY, value);
}

const ALL_DOCUMENTED_FIELDS = new Set(
  Object.values(COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG)
    .flatMap((catalogEntry) => catalogEntry.fieldsToExport),
);

/**
 * Validates an exact explicit request projection. Provider defaults are not
 * accepted, and successful output is a new canonical immutable array.
 */
export function validateComputeOptimizerFieldsToExport(
  exportFamily: unknown,
  operation: unknown,
  fieldsToExport: unknown,
): readonly string[] {
  if (!isExportFamily(exportFamily)) reject("INVALID_EXPORT_FAMILY");
  const catalogEntry = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[exportFamily];
  if (operation !== catalogEntry.operation) reject("OPERATION_MISMATCH");
  if (
    !Array.isArray(fieldsToExport)
    || fieldsToExport.length === 0
    || fieldsToExport.some((value) => typeof value !== "string" || !FIELD.test(value))
  ) reject("INVALID_FIELDS");

  const values = fieldsToExport as string[];
  if (new Set(values).size !== values.length) reject("DUPLICATE_FIELD");
  if (values.some((value, index) => index > 0 && compareCodePoints(values[index - 1]!, value) >= 0)) {
    reject("NON_CANONICAL_ORDER");
  }

  const allowed = new Set(catalogEntry.fieldsToExport);
  for (const value of values) {
    if (allowed.has(value)) continue;
    reject(ALL_DOCUMENTED_FIELDS.has(value) ? "CROSS_FAMILY_FIELD" : "UNKNOWN_FIELD");
  }
  const present = new Set(values);
  if (catalogEntry.minimumProjection.some((value) => !present.has(value))) {
    reject("MINIMUM_FIELD_MISSING");
  }
  return Object.freeze([...values]);
}
