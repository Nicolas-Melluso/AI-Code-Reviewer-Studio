# AI PR Review Pilot

MVP de un reviewer automatico para Pull Requests usando GitHub Actions y GitHub Models.

La idea es agregar un paso de validacion previo al merge que:

- corre automaticamente cuando se crea o actualiza un PR;
- compara el PR contra la rama base;
- bloquea antes de llamar al modelo si detecta posibles credenciales;
- ejecuta validaciones del proyecto, como lint, typecheck y tests;
- manda al modelo el diff filtrado, contexto del repo y logs de validacion;
- publica comentarios inline con bloques `suggestion` aplicables desde GitHub;
- vuelve a correr cuando se aplican cambios al PR.

## Archivos principales

- `.github/workflows/ai-pr-review.yml`: orquesta el pipeline en GitHub Actions.
- `scripts/ai-pr-review.mjs`: calcula el diff, revisa secretos, llama al modelo y publica comentarios en el PR.

## Flujo

```text
Pull Request
  -> GitHub Actions
    -> checkout completo del repo
    -> lint / typecheck / tests
    -> diff base...head
    -> scan de secretos
    -> filtro de archivos irrelevantes
    -> contexto del proyecto
    -> GitHub Models
    -> JSON estructurado
    -> comentarios inline con suggestions
    -> bloqueo si hay findings critical
```

## Seguridad del MVP

El paso mas importante es que el scanner de secretos corre antes de llamar al modelo. Si detecta un archivo o linea sospechosa, el workflow:

1. publica un comentario bloqueante en el PR;
2. falla el job;
3. no envia el codigo al modelo.

Este MVP usa patrones regex internos. Para produccion deberia integrarse `gitleaks` o `trufflehog`.

## Configuracion inicial

El workflow usa GitHub Models:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  models: read
```

Modelo por defecto:

```yaml
AI_REVIEW_MODEL: openai/gpt-4.1
```

Politica inicial:

```yaml
AI_REVIEW_MAX_FINDINGS: "12"
AI_REVIEW_MIN_SEVERITY: low
AI_REVIEW_FAIL_ON: critical
```

## Como probarlo

1. Copiar `.github/workflows/ai-pr-review.yml` y `scripts/ai-pr-review.mjs` a un repo piloto.
2. Confirmar que GitHub Models este habilitado para el repo u organizacion.
3. Abrir un PR con cambios simples.
4. Verificar que el workflow corra automaticamente.
5. Revisar el comentario de `AI PR Review`.
6. Aplicar una suggestion desde GitHub.
7. Confirmar que el nuevo commit dispara otra ejecucion por `synchronize`.

## Criterios de exito del piloto

- Detecta posibles secretos antes de llamar al modelo.
- Publica comentarios utiles y accionables.
- No genera spam excesivo.
- No bloquea salvo findings `critical` o fallos reales del pipeline.
- El equipo puede medir falsos positivos, sugerencias aplicadas, costo y latencia.

## Pendiente para produccion

- Reemplazar regex de secretos por `gitleaks` o `trufflehog`.
- Agregar deduplicacion persistente de comentarios.
- Dividir PRs grandes en chunks por archivo.
- Agregar configuracion por repo con `.ai-review.yml`.
- Convertirlo en reusable Action o GitHub App.
- Definir politica para PRs desde forks externos.
- Agregar metricas y auditoria.