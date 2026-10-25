# Brawl Counter

Counters, builds, draft contra composição, melhores trios e rotação de mapas do
Brawl Stars, com dados ao vivo dos jogadores do topo do ranking.

## Como funciona

- **`collector/collect.mjs`** lê a API oficial do Brawl Stars (pelo proxy da
  RoyaleAPI), pega as últimas partidas dos jogadores do topo do ranking global e
  de alguns países e calcula win rate, pick rate, modos, mapas, matchups,
  sinergia e trios numa janela móvel de 7 dias.
- **`.github/workflows/live.yml`** roda o coletor a cada hora, guarda o estado
  no branch `data` (sempre um único commit, sem crescer o repositório) e publica
  a pasta `site/` no GitHub Pages.
- **`site/index.html`** é o site. Ele lê `data/live.json` (ao vivo) e
  `data/static.json` (builds, dicas, funções e raridades, atualizados toda
  semana) e, com a página aberta, busca dados novos sozinho a cada 5 minutos.

## Configuração (uma vez)

1. Crie uma chave em <https://developer.brawlstars.com> liberada para o IP do
   proxy da RoyaleAPI (veja <https://docs.royaleapi.com/proxy.html>).
2. Em **Settings → Secrets and variables → Actions → New repository secret**,
   crie `BS_API_KEY` com a chave.
3. Em **Settings → Pages**, em *Build and deployment*, escolha **GitHub Actions**.
4. Em **Actions**, abra *Dados ao vivo* e clique em **Run workflow**.

Variáveis opcionais (Settings → Variables): `COUNTRIES` (padrão
`global,BR,US,MX,ES`) e `BS_API_BASE`.

## Teste local sem chave

```
node test/mock-api.mjs &
BS_API_KEY=TESTE BS_API_BASE=http://127.0.0.1:9911/v1 STATE_DIR=/tmp/st OUT_FILE=site/data/live.json node collector/collect.mjs
cd site && python3 -m http.server 8000
```

Fontes de referência: SeeMeta, BrawlPlanet, Brawl Time Ninja. Imagens: Brawlify CDN.
Este projeto não é afiliado à Supercell.
