# ADV-11 pinned AWS CID definition audit

Audited 2026-08-01 from the immutable AWS CID artifact
[`dashboards/euc/euc-dashboard.yaml`](https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/euc/euc-dashboard.yaml)
at commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`. The artifact identifies
dashboard version `v1.2.0` and contains exactly **7 sheets, 82 visuals, and 24
controls**. The audited artifact SHA-256 is
`1342648480b1c839c5f71e8c700c84cdc5525d3f0b74ceaf74aa0c2ec3c85af1`.
Counts include duplicate-titled visuals because they are separate QuickSight
visuals.

| Official sheet | Visuals | Controls | Sutra native area | Local status |
|---|---:|---:|---|---|
| Summary | 28 | 5 | Service and cost summary | Evidence-backed current-period KPIs and server-side account/Region cost breakdowns; rolling three-month series remains unavailable |
| WorkSpaces Desktop Insights | 11 | 6 | WorkSpaces insights | Evidence-backed state, connection, running-mode, account, Region, and bundle aggregates; protocol/OS unavailable |
| WorkSpaces Desktop Usage | 9 | 5 | WorkSpaces usage and logons | Point-in-time connection/mode evidence only; named-user and last-logon views remain privacy-limited |
| WorkSpaces Desktops Metrics | 7 | 2 | Optional CloudWatch performance | Evidence-backed metric state and observations; missing metrics remain unknown |
| WorkSpaces Applications Summary | 19 | 6 | WorkSpaces Applications summary | Evidence-backed fleet/stack/session, fleet-type/state, account, Region, metric, and cost aggregates |
| EUC Cost Optimization | 8 | 0 | Cost-optimization review candidates | Configuration/inventory review signals only; not savings estimates |
| About | 0 | 0 | Evidence and limitations | Contextual native equivalent |

## Exact controls

- **Summary:** Billing Period; Spend; Payer Accounts; Account Names; Linked
  Account ID.
- **WorkSpaces Desktop Insights:** Billing Period; Chart; Region; Payer
  Account; Account Names; Linked Account ID.
- **WorkSpaces Desktop Usage:** Region; Bundle; Linked Account ID; Payer
  Account; Account Names.
- **WorkSpaces Desktops Metrics:** Metrics; DirectoryID.
- **WorkSpaces Applications Summary:** Billing Period; Group by; Fleet Status;
  Linked Account ID; Payer Account; Account Names.
- **EUC Cost Optimization:** none.
- **About:** none.

Sutra activates service, linked-account, and Region filters against the
server-owned snapshot boundary. Billing period is displayed from the active
reconciled CUR2 generation rather than exposed as a selector that could imply
unmaterialized history. Payer aliases, account names, bundle filtering,
Directory IDs, and parameter-driven chart/metric/fleet-status controls remain
unavailable until their server-owned catalogs or aggregate contracts exist.

## Exact visual-title inventory

### Summary — 28

ImageBuilder Count; Streaming Fleets Count; Idle Fleets Count; WorkSpaces
Provisioned vs Workspaces Used (Over 3 Months); Spend by `${pWSDimension}`;
Discounts Previous Month: Credits, Refunds, Others; Total Services Previous
Month; EUC Spend Trend (three separate visuals); Total Accounts Previous Month;
ImageBuilder Costs; Streaming Fleets Cost; Idle Fleets Cost; WorkSpaces
Applications Cost Ratio; Average Usage for AutoStop WorkSpaces (hours); Average
Cost per WorkSpace; Account IDs (two separate visuals); Active RDS Users CALs;
User Costs & Count; Total WorkSpaces by Account (Provisioned AutoStop vs AutoStop
Usage vs AlwaysOn); WorkSpaces Provisioned vs Workspaces Used vs Maintenance;
Total % WorkSpaces by Account (Over 3 Months); Total WorkSpaces by Region; Total
WorkSpaces by Bundle; Total WorkSpaces by Account; Active WorkSpaces.

### WorkSpaces Desktop Insights — 11

WorkSpaces Software Bundle count; WorkSpaces Software Bundle; WorkSpaces Cost
Breakdown and Usage Top 20; WorkSpaces spend per `${pWSDimension3}` (Last 3
Months); WorkSpaces Count and Cost (Monthly Fee - Last 3 Months); WorkSpaces
Daily Count (and WorkSpaces Hours - Last 3 Months); WorkSpaces Running Modes;
Total WorkSpaces by Account; WorkSpaces Count per `${pWSDimension3}`; WorkSpaces
Count (MoM - Last 3 Months); Total WorkSpaces by Bundle.

### WorkSpaces Desktop Usage — 9

Top 10 WorkSpaces with monthly usage (Last 6 Months); WorkSpaces Low Usage (Last
3 Month); Never Logged On; Directory Costs (Previous Month); AlwaysOn
WorkSpaces - Last Logon; Last Logon to WorkSpace (over 30 days ago); Top 10
WorkSpaces daily usage (Last 3 Months); WorkSpaces daily usage/hours (Last 3
Months); WorkSpaces Hours & Count (Daily - Last 7 Days).

### WorkSpaces Desktops Metrics — 7

WorkSpaces High Latency (Over 100ms); Underutilized WorkSpaces based on Memory
(Under 5%); WorkSpaces based on Memory (over 60%); Underutilized WorkSpaces
based on CPU (Under 5%); WorkSpaces based on CPU (over 60%); Average Memory
Usage - Last 7 days - `${pWSDimension5}`; Average CPU - Last 7 days -
`${pWSDimension5}`.

### WorkSpaces Applications Summary — 19

Top 10 Fleets Usage Ratio; Fleets (Stopped - Never Streamed); Top 10 Fleets
Users; WorkSpaces Applications Office Costs & Count; Fleets (Idle) Cost; Fleets
(Streaming) Cost; ImageBuilder Costs; WorkSpaces Applications Cost Ratio;
WorkSpaces Applications spend per Region (Users); WorkSpaces Applications spend
by `${pWSDimension1}`; WorkSpaces Applications spend per Account (Last 3
Months); Fleets Count Streaming vs Stopped; Fleets (Stopped vs Streamed);
WorkSpaces Applications User Costs & Count; Image Builder Costs; Image Builder
Daily usage; Top 10 Fleets spend; Fleet (`${pFleetStatus}`) Cost; User (RDS CAL)
Count.

### EUC Cost Optimization — 8

Image Builders with weekend usage (Last 30 Days); Top 10 Streaming Fleets with
weekend usage (Last 30 Days); AlwaysOn Monthly Cost (Graphics); AlwaysOn Monthly
Costs (NonGraphics); Top 10 WorkSpaces with weekend usage (Last 30 Days); Image
Builder Costs; WorkSpaces (Graphics) AutoStop with monthly usage over 300 hours;
WorkSpaces (Non Graphics) AutoStop with monthly usage over 80 hours.

### About — 0

The sheet has no QuickSight visual objects.

## Evidence-honest exclusions

The official definition contains named-user, username, last-logon, directory,
session-derived user count, weekend-use, and multi-month usage visuals. Sutra
does not recreate those from a point-in-time disconnect, resource state, or
cost line. User/session/instance/network identifiers remain outside the broker
contract. Multi-month charts remain unavailable until immutable accepted
history is materialized with exact completeness and billing lineage.
