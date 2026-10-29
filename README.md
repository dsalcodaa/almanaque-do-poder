# Almanaque do Poder

Uma plataforma de transparência, inteligência pública e análise política.

**Desenvolvido pela NEX — Hub de Análise Estratégica.**

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `index.html` | Página inicial, com painel de números e eleitos de 2026 |
| `politicos.html` | Lista de políticos com filtros por casa, partido e nome |
| `politico.html?id=…` | Perfil: crachá com votos e patrimônio, presença, votações, cota, emendas, leis e contato |
| `leis.html` | Normas aprovadas, com filtros por casa, categoria, ano e autor |
| `rankings.html` | Rankings: leis, homenagens, presença, fidelidade ao partido, cota, patrimônio, votos e emendas |
| `gastos.html` | Cota parlamentar: notas fiscais, categorias, fornecedores, evolução mensal e CSV |
| `comparar.html?ids=a,b` | Dois políticos lado a lado |
| `diario.html` | Citações dos políticos nos diários oficiais (ALEAM, CMM e DOE-AM) |
| `sobre.html` | Página "Sobre o projeto": finalidade, fontes, método e relação com a NEX |
| `relatorio.html` | Modelo de relatório, com exportação em PDF |
| `scripts/coletar.py` | Coletor de dados das fontes oficiais (só biblioteca padrão do Python) |
| `data/` | Dados gerados pelo coletor (`politicos.json`, `normas.json`, `meta.json`, `gastos.json`, `diario.json`, `eleitos-2026.json`) |
| `data/executivo-manual.json` | Ajustes do Executivo (renúncias, sucessões), sempre com fonte |
| `assets/js/app.js` | Renderiza as páginas a partir dos dados |
| `assets/css/tokens.css` | Design system: cores, tipografia e espaçamento |
| `assets/css/style.css` | Componentes |
| `assets/css/print.css` | Layout do PDF, com crédito institucional em todas as páginas |
| `assets/js/nex-brand.js` | Usa o logotipo da NEX quando `brand/nex/logo.svg` existe |
| `brand/nex/` | Pasta para os arquivos oficiais da NEX |

## Rodar localmente

É um site estático, sem build. Abra `index.html` no navegador ou rode:

```sh
python -m http.server 8000
```

## Dados

| Quem | Fonte |
| --- | --- |
| Vereadores de Manaus | SAPL da Câmara Municipal de Manaus |
| Deputados estaduais | SAPL da Assembleia Legislativa do Amazonas |
| Deputados federais | API de Dados Abertos da Câmara dos Deputados |
| Senadores | API de Dados Abertos do Senado Federal |
| Prefeitos | TSE, candidaturas 2024, mais ajustes em `data/executivo-manual.json` |
| Governador e vice | `data/executivo-manual.json`, com fonte |
| Eleitos em 2026 | TSE, candidaturas 2026 |
| Emendas (federais) | Portal da Transparência, API de dados (segredo `PORTAL_TRANSPARENCIA_KEY`) |
| Cota dos vereadores | SIGAE da Câmara Municipal de Manaus |
| Cota dos deputados estaduais | Controle de cota parlamentar da ALEAM (CSV oficial) |
| Diário Oficial | Diários da ALEAM, da Câmara Municipal de Manaus e do Estado (DOE-AM) |
| Cota, presença e votos dos deputados federais | Arquivos de dados abertos da Câmara dos Deputados |
| Votos e patrimônio | TSE: `votacao_candidato_munzona` e `bem_candidato` |
| Presença na CMM e na ALEAM | SAPL, sessões plenárias e presença |
| Votos, presença e cota dos senadores | Dados abertos do Senado (votações nominais e CEAPS) |
| Histórico de todos os candidatos e municípios | TSE, candidaturas, bens, votação e fotos desde 2000 (`tse_historico`) |
| Nome de fornecedores ocultos | BrasilAPI (base de CNPJ da Receita), cache em `data/fontes/cnpj.json` |
| Financiamento de campanha | TSE, prestação de contas dos candidatos desde 2018 (`doacoes`; lê só o CSV do AM dentro do zip nacional) |
| Tribunais e Ministério Público | DadosJusBr (TJAM, MPAM, TRT-11, TRE-AM) e contracheques em PDF do TCE-AM; coleta semestral |
| Votos por município e bairro | TSE: `votacao_candidato_munzona`, `votacao_secao` e locais de votação (`votos_territorio`) |

Para atualizar os dados localmente:

```sh
python scripts/coletar.py            # todas as fontes (cerca de 12 minutos)
python scripts/coletar.py cmm aleam  # só as fontes indicadas
python scripts/coletar.py eleicoes   # votos e patrimônio (TSE, arquivos grandes; não roda no Actions)
python scripts/coletar.py tse_historico  # histórico, fotos e municípios (TSE desde 2000; não roda no Actions)
python scripts/coletar.py doacoes        # financiadores e gastos de campanha (TSE desde 2018; rode depois do histórico)
python scripts/coletar.py votos_territorio  # votos por município e bairro (TSE; baixa cerca de 500 MB na primeira vez)
python scripts/coletar.py tribunais      # força a coleta dos tribunais (normalmente roda a cada seis meses)
```

O GitHub Actions roda o coletor todo dia às 6h (horário de Manaus), salva os dados no repositório e publica o site.

A leitura dos diários usa o `pdftotext` (pacote `poppler-utils` no Linux). Sem ele, o coletor tenta o `pypdf`; sem nenhum dos dois, pula os diários e mantém os dados anteriores.

Ainda não integrado: Diário Oficial do Município de Manaus (o servidor não respondeu nos testes) e as emendas do Portal da Transparência de Manaus (sem API; o portal só oferece consultas em telas).

## Identidade visual

- Fundo papel `#f1ece4`, texto `#1a1a1a`, destaque vermelho `#b3261e`
- Títulos em serifa pesada (Source Serif 4), texto em Inter
- Cabeçalho em caixa alta com filete preto, números grandes com filete no topo e listas com barra lateral

## Crédito institucional

O crédito "Almanaque do Poder · Desenvolvido pela NEX — Hub de Análise Estratégica." deve aparecer em:

- no rodapé de todas as páginas;
- na página inicial (assinatura discreta);
- na página "Sobre o projeto";
- em todo PDF exportado (rodapé de página via `@page`);
- nos metadados (`author`, `creator`, `publisher`, JSON-LD e `humans.txt`).

A NEX é a instituição responsável pelo desenvolvimento da plataforma. O projeto não declara apoio, patrocínio nem endosso de órgãos públicos.

---

Almanaque do Poder · Desenvolvido pela NEX — Hub de Análise Estratégica.
