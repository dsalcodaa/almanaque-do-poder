# Almanaque do Poder

Uma plataforma de transparência, inteligência pública e análise política.

**Desenvolvido pela NEX — Hub de Análise Estratégica.**

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `index.html` | Página inicial |
| `sobre.html` | Página "Sobre o projeto": finalidade, transparência e relação com a NEX |
| `relatorio.html` | Modelo de relatório, com exportação em PDF |
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
