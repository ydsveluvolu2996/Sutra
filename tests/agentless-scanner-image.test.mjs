import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../services/agentless-scanner/Dockerfile", import.meta.url),
  "utf8",
);

test("agentless scanner builds versioned Trivy from an immutable patched module closure", () => {
  assert.ok(
    dockerfile.includes(
      "FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS trivy",
    ),
  );
  assert.ok(dockerfile.includes("go mod init sutra.local/trivy-release-build"));
  assert.ok(dockerfile.includes("github.com/aquasecurity/trivy@v0.72.0"));
  assert.ok(
    dockerfile.includes(
      "h1:W3v+NE94olOzk3nSwwha59DTBsbcgLRXa4QNSJpRQQM=",
    ),
  );
  assert.ok(dockerfile.includes("golang.org/x/text@v0.39.0"));
  assert.ok(
    dockerfile.includes(
      "h1:UbZz4pLOvn600D6Oh6GGEI6VAmndrEBLv8/6BEXzyus=",
    ),
  );
  assert.ok(dockerfile.includes("google.golang.org/grpc@v1.82.1"));
  assert.ok(
    dockerfile.includes(
      "h1:NnAxzGRA0677vCa4BUkOAnO5+FfQqVl9iUXeD0IqcGE=",
    ),
  );
  assert.ok(dockerfile.includes("golang.org/x/net@v0.56.0"));
  assert.ok(
    dockerfile.includes(
      "h1:Rw8j/hFzGvJUZwNBXnAtf5sVDVt+65SK2C7IxCxZt5o=",
    ),
  );
  assert.ok(dockerfile.includes("oras.land/oras-go/v2@v2.6.2"));
  assert.ok(
    dockerfile.includes(
      "h1:N04RXngAp1LJKTG6ifz3xHPipasEkWr+hFmInja5YKo=",
    ),
  );
  assert.ok(dockerfile.includes("GOPROXY=https://proxy.golang.org"));
  assert.ok(dockerfile.includes("GOSUMDB=sum.golang.org"));
  assert.ok(
    dockerfile.includes("github.com/aquasecurity/trivy/cmd/trivy"),
  );
  assert.ok(
    dockerfile.includes(
      "github.com/aquasecurity/trivy/pkg/version/app.ver=0.72.0-sutra.1",
    ),
  );
  assert.equal(dockerfile.includes("9321f90278433af7504a258597101e65433fad75"), false);
  assert.equal(dockerfile.includes("FROM aquasec/trivy:"), false);
  assert.equal(dockerfile.includes("--ignore-unfixed"), false);
});

test("agentless scanner runtime is digest-pinned and contains no build toolchain", () => {
  const runtimePackages = dockerfile.indexOf("AS scanner-runtime-packages");
  const packageManagerRemoval = dockerfile.indexOf("rm -rf /usr/local/lib/node_modules/npm");
  const finalRuntime = dockerfile.indexOf("FROM scanner-runtime-packages");
  assert.ok(
    dockerfile.includes(
      "FROM node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e",
    ),
  );
  assert.ok(dockerfile.includes("apk add --no-cache"));
  assert.ok(dockerfile.includes("/sbin/apk"));
  assert.ok(dockerfile.includes("COPY --from=trivy /out/trivy /usr/local/bin/trivy"));
  assert.ok(dockerfile.includes("rm -rf /usr/local/lib/node_modules/npm"));
  assert.ok(
    runtimePackages >= 0
      && packageManagerRemoval > runtimePackages
      && finalRuntime > packageManagerRemoval,
    "package managers must be absent from the reusable scanner runtime stage",
  );
  assert.equal(dockerfile.includes("COPY --from=trivy /usr/local/go"), false);
  assert.equal(dockerfile.includes("COPY --from=trivy /go"), false);
});

test("both Trivy databases are baked into the immutable image for private runtime scans", () => {
  assert.match(dockerfile, /FROM trivy AS trivy-db/u);
  assert.match(dockerfile, /\/out\/trivy image --download-db-only/u);
  assert.match(dockerfile, /\/out\/trivy image --download-java-db-only/u);
  assert.match(dockerfile, /test -s \/out\/trivy-cache\/db\/metadata\.json/u);
  assert.match(dockerfile, /test -s \/out\/trivy-cache\/java-db\/metadata\.json/u);
  assert.match(dockerfile, /COPY --from=trivy-db \/out\/trivy-cache \/var\/cache\/trivy/u);
});
