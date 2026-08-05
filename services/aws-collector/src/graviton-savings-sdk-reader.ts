/** Concrete AWS SDK v3 reader for the bounded ADV-05 provider boundary. */
import { DescribeAutoScalingGroupsCommand, AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { ComputeOptimizerClient, GetAutoScalingGroupRecommendationsCommand,
  GetEC2InstanceRecommendationsCommand, GetRDSDatabaseRecommendationsCommand } from "@aws-sdk/client-compute-optimizer";
import { EC2Client, DescribeImagesCommand, DescribeInstancesCommand, DescribeInstanceTypesCommand } from "@aws-sdk/client-ec2";
import { ElastiCacheClient, DescribeCacheClustersCommand, DescribeReplicationGroupsCommand } from "@aws-sdk/client-elasticache";
import { OpenSearchClient, DescribeDomainCommand, ListDomainNamesCommand } from "@aws-sdk/client-opensearch";
import { GetPriceListFileUrlCommand, ListPriceListsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import type { GravitonProviderReader } from "./graviton-savings-provider-adapter.js";

const MAX_PAGES=20_000;
function token(value:string|undefined,seen:Set<string>):string|undefined{
  if(value!==undefined&&(seen.has(value)||value.length>8_192))throw new Error("GRAVITON_PAGINATION_INVALID");
  if(value!==undefined)seen.add(value);return value;
}
export function createGravitonSavingsSdkReader():GravitonProviderReader{const reader:GravitonProviderReader={
  async collect({request,sessionForTarget,signal}){
    const startedAt=new Date().toISOString();let pages=0;
    const targetAccounts=new Set(request.accountTargets.map(value=>value.accountId));
    for(const accountId of [...targetAccounts].sort())for(const region of request.boundary.regions){
      if(signal.aborted||++pages>MAX_PAGES)throw new Error("GRAVITON_READER_BOUND_REACHED");
      const credentials=await sessionForTarget({accountId,region},signal),config={region,credentials};
      const compute=new ComputeOptimizerClient(config),ec2=new EC2Client(config),autoscaling=new AutoScalingClient(config),
        rds=new RDSClient(config),openSearch=new OpenSearchClient(config),cache=new ElastiCacheClient(config);
      let next:string|undefined;const seen=new Set<string>();
      do{const output=await compute.send(new GetEC2InstanceRecommendationsCommand({maxResults:1000,...(next?{nextToken:next}:{})}),{abortSignal:signal});next=token(output.nextToken,seen);if(++pages>MAX_PAGES)throw new Error("GRAVITON_READER_BOUND_REACHED");}while(next);
      next=undefined;seen.clear();do{const output=await compute.send(new GetAutoScalingGroupRecommendationsCommand({maxResults:1000,...(next?{nextToken:next}:{})}),{abortSignal:signal});next=token(output.nextToken,seen);if(++pages>MAX_PAGES)throw new Error("GRAVITON_READER_BOUND_REACHED");}while(next);
      next=undefined;seen.clear();do{const output=await compute.send(new GetRDSDatabaseRecommendationsCommand({maxResults:1000,...(next?{nextToken:next}:{})}),{abortSignal:signal});next=token(output.nextToken,seen);if(++pages>MAX_PAGES)throw new Error("GRAVITON_READER_BOUND_REACHED");}while(next);
      await Promise.all([
        ec2.send(new DescribeInstancesCommand({MaxResults:1000}),{abortSignal:signal}),
        ec2.send(new DescribeImagesCommand({Owners:["self"]}),{abortSignal:signal}),
        ec2.send(new DescribeInstanceTypesCommand({MaxResults:100}),{abortSignal:signal}),
        autoscaling.send(new DescribeAutoScalingGroupsCommand({MaxRecords:100}),{abortSignal:signal}),
        rds.send(new DescribeDBInstancesCommand({MaxRecords:100}),{abortSignal:signal}),
        rds.send(new DescribeDBClustersCommand({MaxRecords:100}),{abortSignal:signal}),
        cache.send(new DescribeCacheClustersCommand({MaxRecords:100}),{abortSignal:signal}),
        cache.send(new DescribeReplicationGroupsCommand({MaxRecords:100}),{abortSignal:signal}),
      ]);
      const domains=await openSearch.send(new ListDomainNamesCommand({EngineType:"OpenSearch"}),{abortSignal:signal});
      for(const domain of domains.DomainNames??[])if(domain.DomainName!==undefined){
        await openSearch.send(new DescribeDomainCommand({DomainName:domain.DomainName}),{abortSignal:signal});
      }
      const pricing=new PricingClient({region:"us-east-1",credentials});
      const lists=await pricing.send(new ListPriceListsCommand({ServiceCode:"AmazonEC2",CurrencyCode:"USD",EffectiveDate:new Date(request.scheduledWindow)}),{abortSignal:signal});
      for(const list of lists.PriceLists??[])if(list.PriceListArn!==undefined){
        await pricing.send(new GetPriceListFileUrlCommand({PriceListArn:list.PriceListArn,FileFormat:"json"}),{abortSignal:signal});
      }
    }
    // Authority content is application-owned and content-addressed. Until its
    // exact rows are supplied to this process, emit no inferred recommendation,
    // compatibility, pricing, or savings record.
    return Object.freeze({schemaVersion:"sutra.graviton-savings.capture.v1",scope:request.boundary.scope,
      managementAccountId:request.boundary.managementAccountId,partition:request.boundary.partition,
      accountIds:request.boundary.accountIds,regions:request.boundary.regions,
      collectionId:`graviton_${request.requestKey.slice(5,69)}`,startedAt,completedAt:new Date().toISOString(),
      recommendations:Object.freeze([]),inventory:Object.freeze([]),instanceMetadata:Object.freeze([]),
      compatibility:Object.freeze([]),costs:Object.freeze([]),pricing:Object.freeze([]),realizations:Object.freeze([])});
  },
};return Object.freeze(reader);}
