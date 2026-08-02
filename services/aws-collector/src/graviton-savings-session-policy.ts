/** Exact read-only STS intersection for one ADV-05 account/Region target. */
import { GRAVITON_SAVINGS_SESSION_ACTIONS } from "./graviton-savings-permission-contract.js";
export function gravitonSavingsSessionPolicy(input:{readonly accountId:string;
  readonly partition:"aws"|"aws-cn"|"aws-us-gov";readonly region:string}):string{
  if(!/^\d{12}$/u.test(input.accountId)||!["aws","aws-cn","aws-us-gov"].includes(input.partition)
    ||!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(input.region))throw new Error("GRAVITON_SESSION_SCOPE_INVALID");
  const policy=JSON.stringify({Version:"2012-10-17",Statement:[
    {Sid:"VerifyGravitonIdentity",Effect:"Allow",Action:["sts:GetCallerIdentity"],Resource:"*"},
    {Sid:"ReadExactGravitonEvidence",Effect:"Allow",Action:GRAVITON_SAVINGS_SESSION_ACTIONS,Resource:"*"},
  ]});
  if(Buffer.byteLength(policy,"utf8")>2_048)throw new Error("GRAVITON_SESSION_POLICY_TOO_LARGE");return policy;
}
