# @blackshop/landinglab-deploy

**Propósito:** Squad 5 (Deploy) do pipeline LandingLab. Publica o HTML gerado pela Squad 4 num subdomínio wildcard do storefront Vercel — ou compra domínio raiz via Spaceship quando solicitado — e valida SSL/health antes de marcar `deployed`.

## API pública

```ts
import {
  runDeploySquad,
  validateDeployJobPayload,
  DeployJobPayloadSchema,
} from '@blackshop/landinglab-deploy';
```

### `runDeploySquad(input, deps)`

Orquestra 5 agents (Domain Broker, DNS Configurator, Storefront Publisher, SSL Validator, Publish Verifier). Retorna sucesso com metadata completa OU failure estruturado com agent trace.

```ts
const output = await runDeploySquad(
  { landingPageId, buildOutput, deploymentType: 'subdomain', slug: 'minha-landing' },
  { spaceship, vercel },
);
// output.success === true → RunDeploySquadSuccessOutput (com deploymentMetadata)
// output.success === false → RunDeploySquadFailureOutput (com failedAgent + trace)
```

### Schemas Zod

`DeployJobPayloadSchema`, `DeploymentMetadataSchema`, `RunDeploySquadOutputSchema`, `DnsRecordSchema`, `SslSetupSchema`, `HealthCheckResultSchema`, `AgentTraceEntrySchema`. Validadores: `validateDeployJobPayload`, `validateDeploymentMetadata`, `validateRunDeploySquadOutput`. Erro tipado: `DeploymentValidationError`.

### Helpers de subdomínio

- `computeSubdomainHostname(slug)` — normaliza + concatena com `ROOT_DOMAIN`
- `sanitizeSlug(raw)` — enforce kebab-case + rejeita `RESERVED_SUBDOMAINS`
- `verificationUrlFor(hostname)` — URL de health check

### Agent runners individuais

`runDomainBroker`, `runDnsConfigurator`, `runStorefrontPublisher`, `runSslValidator`, `runPublishVerifier`. `__resetWildcardAssertionForTests` é escape hatch pra suite (Wave 2 valida wildcard 1x por process).

### Providers

- `createSpaceshipClient(config)` — compra + DNS records em domínio raiz
- `createVercelClient(config)` — attach de domínio no project + verify

Erros tipados: `ProviderConfigError`, `ProviderRetryableError`, `NotImplementedError`.

## Deps externos

- Spaceship API — `SPACESHIP_API_KEY` + `SPACESHIP_API_SECRET` — compra de domínio raiz (custo ~$8-15/domínio, LATAM otimizado)
- Vercel API v10 — `VERCEL_API_TOKEN` + `VERCEL_STOREFRONT_PROJECT_ID` — attach/verify domínio no project storefront
- `@blackshop/landinglab-domains` — adapters HTTP compartilhados

## Como testar

```bash
pnpm --filter @blackshop/landinglab-deploy test
```

## Ver também

- Story: `docs/stories/13.8.landinglab-deploy-squad.story.md`
- Runbook: `docs/runbooks/landinglab-e2e-setup.md`
- Adapters de domínio: `@blackshop/landinglab-domains`
- Worker processor: `apps/worker/src/processors/publish.processor.ts`
