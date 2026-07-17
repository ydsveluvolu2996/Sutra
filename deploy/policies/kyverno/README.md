# Sutra Kyverno admission pack

The default Kustomize target contains only `validationFailureAction: Audit`
policies. It records policy outcomes without asserting that workloads were
blocked. The system namespaces `kube-system`, `kube-public`,
`kube-node-lease`, and `kyverno` are excluded from every included rule.

Before any promotion to `Enforce`, an operator must:

1. install the pack in Audit through the customer's approved delivery system;
2. observe a representative window and import immutable PolicyReport evidence;
3. resolve failures or create exact, justified, independently approved
   exceptions with mandatory expiry;
4. test admission availability, break-glass access, rollback, and Kyverno
   failure behavior;
5. pin the reviewed policy bundle digest;
6. obtain approval from a different authorized human;
7. promote through GitOps or another customer-controlled change mechanism;
8. verify blocking using separate admission-decision evidence.

Sutra's browser UI must never run `kubectl`, Helm, or mutate a customer cluster.
The promotion request example is a control-plane review representation, not a
Kubernetes object.

The files under `optional/` are deliberately excluded from
`kustomization.yaml`. They contain fail-closed signature and provenance
templates. Installing them with `SET_ME` values is unsafe and unsupported.
Configure identity, registry, trust root, attestation predicate, rollback and
failure behavior; test in Audit; then obtain a separate approval before
creating an Enforce release.
