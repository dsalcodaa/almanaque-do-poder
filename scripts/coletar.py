"""
Coletor de dados do Almanaque do Poder.

Busca dados públicos em fontes oficiais e grava JSON em data/:
  - SAPL da Câmara Municipal de Manaus (vereadores, normas, autorias)
  - SAPL da Assembleia Legislativa do Amazonas (deputados estaduais)
  - API de Dados Abertos da Câmara dos Deputados (deputados federais do AM)
  - API de Dados Abertos do Senado Federal (senadores do AM)
  - TSE, candidaturas (prefeitos eleitos em 2024 e eleitos em 2026)
  - data/executivo-manual.json (ajustes do Executivo, sempre com fonte)

Só usa a biblioteca padrão do Python. Se uma fonte falhar, mantém o
arquivo anterior daquela fonte em data/fontes/ e segue com as demais.

Uso:  python scripts/coletar.py              (todas as fontes)
      python scripts/coletar.py cmm aleam    (só as fontes indicadas)
"""

from __future__ import annotations

import csv
import html
import io
import json
import re
import shutil
import subprocess
import tempfile
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "data"
FONTES = DADOS / "fontes"
CACHE = RAIZ / ".cache"
UA = "AlmanaqueDoPoder/1.0 (NEX - Hub de Analise Estrategica)"
HOJE = date.today().isoformat()


# ---------------------------------------------------------------- utilidades

def log(*a):
    print(*a, file=sys.stderr, flush=True)


def baixar(url: str, timeout: int = 90, tentativas: int = 3) -> bytes:
    erro = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            erro = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"falha ao baixar {url}: {erro}")


def jget(url: str, **kw):
    return json.loads(baixar(url, **kw))


def https(url: str | None) -> str | None:
    if not url:
        return None
    return re.sub(r"^http://", "https://", url)


def sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()


def titulo(s: str) -> str:
    """Converte NOME EM CAIXA ALTA para Nome em Caixa Alta, mantendo preposições."""
    if not s or not s.isupper():
        return s
    minus = {"da", "de", "do", "das", "dos", "e"}
    partes = []
    for i, p in enumerate(s.lower().split()):
        partes.append(p if (i and p in minus) else p[:1].upper() + p[1:])
    return " ".join(partes)


def salvar(nome: str, obj) -> None:
    caminho = DADOS / nome
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def ler(nome: str, padrao=None):
    caminho = DADOS / nome
    if caminho.exists():
        return json.loads(caminho.read_text(encoding="utf-8"))
    return padrao


# ------------------------------------------------- classificação de normas

CATEGORIAS = [
    ("Título honorífico", r"titulo|cidada|cidadao|honorari|benemerit"),
    ("Utilidade pública", r"utilidade publica"),
    ("Honraria", r"medalha|comenda|diploma|mocao de aplauso|ordem do merito|honra ao merito"),
    ("Denominação", r"\bdenomina|da nome|confere o nome|nome de "),
    ("Data comemorativa", r"institui o dia|institui a semana|institui o mes|dia municipal|dia estadual|semana municipal|semana estadual|mes municipal|mes estadual|calendario oficial|data comemorativa|inclui no calendario"),
]
HOMENAGENS = {"Título honorífico", "Utilidade pública", "Honraria", "Denominação", "Data comemorativa"}


def categoria(ementa: str) -> str:
    t = sem_acento(ementa)
    for nome, padrao in CATEGORIAS:
        if re.search(padrao, t):
            return nome
    return "Políticas públicas e outros"


# ----------------------------------------------------------------- SAPL

def sapl_paginas(base: str, caminho: str, params: dict | None = None, workers: int = 4) -> list[dict]:
    params = dict(params or {})
    params["page_size"] = 100
    # Sem ordem fixa a API repete e pula registros entre páginas
    params.setdefault("o", "id")
    url = f"{base}{caminho}?{urllib.parse.urlencode(params)}"
    primeira = jget(url)
    resultados = list(primeira["results"])
    total = primeira["pagination"]["total_pages"]
    if total > 1:
        urls = [f"{url}&page={p}" for p in range(2, total + 1)]
        with ThreadPoolExecutor(workers) as ex:
            for pagina in ex.map(jget, urls):
                resultados.extend(pagina["results"])
    return resultados


def coletar_sapl(casa: str, base: str, cargo: str, esfera: str, municipio: str | None) -> dict:
    log(f"[{casa}] SAPL {base}")
    legis = sapl_paginas(base, "/api/parlamentares/legislatura/")
    atual = next(
        (lg for lg in legis if lg["data_inicio"] <= HOJE <= lg["data_fim"]),
        max(legis, key=lambda x: x["data_inicio"]),
    )
    inicio = atual["data_inicio"]
    ano_inicio = int(inicio[:4])

    mandatos = sapl_paginas(base, "/api/parlamentares/mandato/", {"legislatura": atual["id"]})
    ids_mandato = {m["parlamentar"] for m in mandatos if (m.get("data_fim_mandato") or "9999") >= HOJE}
    parlamentares = [p for p in sapl_paginas(base, "/api/parlamentares/parlamentar/", {"ativo": "True"}) if p["id"] in ids_mandato]

    partidos = {p["id"]: p["sigla"] for p in sapl_paginas(base, "/api/parlamentares/partido/")}
    filiacao = {}
    for f in sorted(sapl_paginas(base, "/api/parlamentares/filiacao/"), key=lambda f: f.get("data") or ""):
        if not f.get("data_desfiliacao"):
            filiacao[f["parlamentar"]] = partidos.get(f["partido"])

    autores = sapl_paginas(base, "/api/base/autor/")
    autor_para_parl = {a["id"]: a["object_id"] for a in autores if a.get("object_id") in ids_mandato}
    nome_autor = {a["id"]: a["nome"] for a in autores}

    # Proposições em que o parlamentar é o primeiro autor, na legislatura atual
    autorias = sapl_paginas(base, "/api/materia/autoria/", {"primeiro_autor": "True"})
    materia_autor: dict[int, int] = {}
    props: dict[int, Counter] = {}
    for a in autorias:
        materia_autor.setdefault(a["materia"], a["autor"])
        pid = autor_para_parl.get(a["autor"])
        if pid is None:
            continue
        m = re.search(r" - (.+?) nº \S+ de (\d{4})", a.get("__str__", ""))
        if not m or int(m.group(2)) < ano_inicio:
            continue
        props.setdefault(pid, Counter())[m.group(1).strip()] += 1

    # Normas publicadas desde o início da legislatura
    tipos = {t["id"]: t["descricao"] for t in sapl_paginas(base, "/api/norma/tiponormajuridica/")}
    normas_raw = []
    for ano in range(ano_inicio, date.today().year + 1):
        normas_raw += sapl_paginas(base, "/api/norma/normajuridica/", {"ano": ano})
    # Nome normalizado -> parlamentar, para ler a autoria escrita na indexação
    por_nome = {sem_acento(p["nome_parlamentar"]): p["id"] for p in parlamentares}

    def autoria_texto(indexacao: str):
        m = re.search(r"Autoria:\s*([^\r\n/]+)", indexacao or "")
        if not m:
            return None, None
        # "Ver. Fulano, Subscrito pelos Vers. ..." -> primeiro autor é Fulano
        texto = re.sub(r"\s+", " ", m.group(1).split(",")[0]).strip()
        limpo = sem_acento(re.sub(r"^(Ver(eador)?a?\.?|Dep(utad[oa])?\.?)\s+", "", texto, flags=re.I)).strip(" .")
        return por_nome.get(limpo), texto

    # A paginação do SAPL pode pular registros. Busca direto pelo projeto
    # a autoria das normas que ficaram sem autor.
    faltando = sorted({n["materia"] for n in normas_raw
                       if n.get("materia") and n["materia"] not in materia_autor and (n.get("data") or "") >= inicio})
    if faltando:
        log(f"[{casa}] buscando autoria de {len(faltando)} projetos")

        def autoria_de(mid):
            try:
                res = jget(f"{base}/api/materia/autoria/?materia={mid}")["results"]
            except Exception:  # noqa: BLE001
                return mid, None
            prim = [a for a in res if a.get("primeiro_autor")] or res
            return mid, (prim[0]["autor"] if prim else None)

        with ThreadPoolExecutor(6) as ex:
            for mid, autor in ex.map(autoria_de, faltando):
                if autor:
                    materia_autor[mid] = autor
        faltam_nomes = {a for a in materia_autor.values() if a not in nome_autor}
        for a in faltam_nomes:
            try:
                nome_autor[a] = jget(f"{base}/api/base/autor/{a}/")["nome"]
            except Exception:  # noqa: BLE001
                pass

    normas = []
    por_parl: dict[int, list] = {}
    for n in normas_raw:
        if (n.get("data") or "") < inicio:
            continue
        # Decretos do Executivo não são produção legislativa
        if "executivo" in sem_acento(tipos.get(n["tipo"], "")):
            continue
        autor = materia_autor.get(n.get("materia"))
        pid = autor_para_parl.get(autor)
        nome_txt = None
        if pid is None:
            pid, nome_txt = autoria_texto(n.get("indexacao"))
        ementa = re.sub(r"\s+", " ", n.get("ementa") or "").strip()
        item = {
            "id": f"{casa}-n{n['id']}",
            "casa": casa,
            "tipo": tipos.get(n["tipo"], ""),
            "numero": n.get("numero"),
            "ano": n.get("ano"),
            "data": n.get("data"),
            "ementa": ementa[:500],
            "categoria": categoria(ementa),
            "autor": f"{casa}-{pid}" if pid else None,
            "autor_nome": titulo(nome_autor.get(autor, "")) if autor else nome_txt,
            "url": f"{base}/norma/{n['id']}",
        }
        normas.append(item)
        if pid:
            por_parl.setdefault(pid, []).append(item)

    politicos = []
    for p in parlamentares:
        minhas = por_parl.get(p["id"], [])
        cats = Counter(x["categoria"] for x in minhas)
        politicos.append({
            "id": f"{casa}-{p['id']}",
            "nome": titulo(p["nome_parlamentar"]),
            "nome_completo": titulo(p.get("nome_completo") or ""),
            "cargo": cargo,
            "casa": casa,
            "esfera": esfera,
            "partido": filiacao.get(p["id"]),
            "uf": "AM",
            "municipio": municipio,
            "foto": https(p.get("fotografia")),
            "email": p.get("email") or None,
            "profissao": p.get("profissao") or None,
            "fonte": f"{base}/parlamentar/{p['id']}",
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(props.get(p["id"], Counter()).values()),
                "proposicoes_tipo": dict(props.get(p["id"], Counter()).most_common()),
                "normas": len(minhas),
                "homenagens": sum(v for k, v in cats.items() if k in HOMENAGENS),
                "normas_categoria": dict(cats.most_common()),
                "autoria": "primeiro autor",
            },
        })
    log(f"[{casa}] {len(politicos)} parlamentares, {len(normas)} normas")
    return {"politicos": politicos, "normas": normas, "legislatura": {"inicio": inicio, "fim": atual["data_fim"]}}


# ------------------------------------------------------ Câmara dos Deputados

CAMARA = "https://dadosabertos.camara.leg.br/api/v2"


def coletar_camara() -> dict:
    log("[camara] API Câmara dos Deputados")
    inicio = "2023-02-01"
    deps = jget(f"{CAMARA}/deputados?siglaUf=AM&itens=100&ordem=ASC&ordenarPor=nome")["dados"]

    def detalhe(d):
        tipos = Counter()
        for sigla in ("PL", "PLP", "PEC", "PDL"):
            url = f"{CAMARA}/proposicoes?idDeputadoAutor={d['id']}&siglaTipo={sigla}&dataApresentacaoInicio={inicio}&itens=100"
            while url:
                pg = jget(url)
                tipos[sigla] += len(pg["dados"])
                url = next((l["href"] for l in pg["links"] if l["rel"] == "next"), None)
        info = jget(f"{CAMARA}/deputados/{d['id']}")["dados"]
        return {
            "id": f"camara-{d['id']}",
            "nome": d["nome"],
            "nome_completo": titulo(info.get("nomeCivil") or ""),
            "cargo": "Deputado(a) federal",
            "casa": "camara",
            "esfera": "federal",
            "partido": d.get("siglaPartido"),
            "uf": "AM",
            "municipio": None,
            "foto": https(d.get("urlFoto")),
            "email": d.get("email"),
            "profissao": None,
            "fonte": f"https://www.camara.leg.br/deputados/{d['id']}",
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(tipos.values()),
                "proposicoes_tipo": dict(tipos.most_common()),
                "normas": None,
                "homenagens": None,
                "normas_categoria": {},
                "autoria": "autoria ou coautoria",
            },
        }

    with ThreadPoolExecutor(4) as ex:
        politicos = list(ex.map(detalhe, deps))
    log(f"[camara] {len(politicos)} deputados")
    return {"politicos": politicos, "normas": []}


# ---------------------------------------------------------- Senado Federal

SENADO = "https://legis.senado.leg.br/dadosabertos"


def coletar_senado() -> dict:
    log("[senado] API Senado Federal")
    inicio = "2023-02-01"
    lista = jget(f"{SENADO}/senador/lista/atual.json")["ListaParlamentarEmExercicio"]["Parlamentares"]["Parlamentar"]
    am = [p["IdentificacaoParlamentar"] for p in lista if p["IdentificacaoParlamentar"].get("UfParlamentar") == "AM"]
    politicos, normas = [], []
    for s in am:
        procs = jget(f"{SENADO}/processo.json?codigoParlamentarAutor={s['CodigoParlamentar']}")
        nome = sem_acento(s["NomeParlamentar"])
        tipos, cats = Counter(), Counter()
        for p in procs:
            if (p.get("dataApresentacao") or "") < inicio:
                continue
            primeiro = sem_acento((p.get("autoria") or "").split(",")[0])
            if nome not in primeiro:
                continue
            sigla = (p.get("identificacao") or "").split(" ")[0]
            tipos[sigla] += 1
            situacao = (p.get("situacaoAtual") or "") + " " + (p.get("siglaTipoDeliberacao") or "")
            if "NORMA" in situacao.upper():
                ementa = (p.get("ementa") or "").strip()
                item = {
                    "id": f"senado-n{p['id']}",
                    "casa": "senado",
                    "tipo": p.get("tipoDocumento") or sigla,
                    "numero": p.get("identificacao"),
                    "ano": (p.get("dataApresentacao") or "")[:4],
                    "data": p.get("dataSituacaoAtual") or p.get("dataApresentacao"),
                    "ementa": ementa[:500],
                    "categoria": categoria(ementa),
                    "autor": f"senado-{s['CodigoParlamentar']}",
                    "autor_nome": s["NomeParlamentar"],
                    "url": f"https://www25.senado.leg.br/web/atividade/materias/-/materia/{p.get('codigoMateria')}",
                }
                normas.append(item)
                cats[item["categoria"]] += 1
        politicos.append({
            "id": f"senado-{s['CodigoParlamentar']}",
            "nome": s["NomeParlamentar"],
            "nome_completo": s.get("NomeCompletoParlamentar"),
            "cargo": "Senador(a)",
            "casa": "senado",
            "esfera": "federal",
            "partido": s.get("SiglaPartidoParlamentar"),
            "uf": "AM",
            "municipio": None,
            "foto": https(s.get("UrlFotoParlamentar")),
            "email": s.get("EmailParlamentar"),
            "profissao": None,
            "fonte": https(s.get("UrlPaginaParlamentar")),
            "periodo": inicio,
            "metricas": {
                "proposicoes": sum(tipos.values()),
                "proposicoes_tipo": dict(tipos.most_common()),
                "normas": sum(cats.values()),
                "homenagens": sum(v for k, v in cats.items() if k in HOMENAGENS),
                "normas_categoria": dict(cats.most_common()),
                "autoria": "primeiro autor",
            },
        })
    log(f"[senado] {len(politicos)} senadores, {len(normas)} normas")
    return {"politicos": politicos, "normas": normas}


# ------------------------------------------------ Portal da Transparência

PORTAL = "https://api.portaldatransparencia.gov.br/api-de-dados"
# Nome do autor como aparece no Portal, quando difere do nome parlamentar
NOME_PORTAL = {"camara-220712": ["FAUSTO SANTOS JR.", "FAUSTO JR."]}


def valor(s: str | None) -> float:
    if not s:
        return 0.0
    return float(s.replace(".", "").replace(",", "."))


def coletar_emendas() -> dict:
    """Emendas parlamentares dos deputados federais e senadores do AM."""
    import os

    chave = os.environ.get("PORTAL_TRANSPARENCIA_KEY")
    if not chave:
        raise RuntimeError("variável PORTAL_TRANSPARENCIA_KEY não definida")
    federais = [p for f in ("camara", "senado") for p in (ler(f"fontes/{f}.json") or {}).get("politicos", [])]
    if not federais:
        raise RuntimeError("rode antes as fontes camara e senado")

    def portal(nome: str, ano: int, pagina: int):
        q = urllib.parse.urlencode({"nomeAutor": nome, "ano": ano, "pagina": pagina})
        req = urllib.request.Request(f"{PORTAL}/emendas?{q}", headers={"chave-api-dados": chave, "Accept": "application/json", "User-Agent": UA})
        for i in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 429:  # limite de requisições por minuto
                    time.sleep(30)
                    continue
                raise
            except Exception:  # noqa: BLE001
                time.sleep(3 * (i + 1))
        raise RuntimeError(f"Portal não respondeu para {nome} {ano}")

    saida = {}
    for p in federais:
        nomes = NOME_PORTAL.get(p["id"]) or [sem_acento(p["nome"]).upper()]
        nome = nomes[0]
        itens, vistos = [], set()
        for nome_busca in nomes:
            for ano in range(2023, date.today().year + 1):
                pagina = 1
                while True:
                    lote = portal(nome_busca, ano, pagina)
                    time.sleep(0.8)  # fica abaixo do limite de 90 requisições por minuto
                    # A busca do Portal é por trecho do nome: confere o nome exato
                    for e in lote:
                        if e.get("nomeAutor") in nomes and e.get("codigoEmenda") not in vistos:
                            vistos.add(e.get("codigoEmenda"))
                            itens.append(e)
                    if len(lote) < 15:
                        break
                    pagina += 1
        por_funcao, por_local, por_ano = Counter(), Counter(), Counter()
        for e in itens:
            pago = valor(e.get("valorPago")) + valor(e.get("valorRestoPago"))
            por_funcao[e.get("funcao") or "Não informada"] += pago
            por_local[e.get("localidadeDoGasto") or "Não informada"] += pago
            por_ano[str(e["ano"])] += pago
        saida[p["id"]] = {
            "autor_portal": nome,
            "quantidade": len(itens),
            "empenhado": round(sum(valor(e.get("valorEmpenhado")) for e in itens), 2),
            "pago": round(sum(valor(e.get("valorPago")) + valor(e.get("valorRestoPago")) for e in itens), 2),
            "por_ano": {k: round(v, 2) for k, v in sorted(por_ano.items())},
            "por_funcao": {k: round(v, 2) for k, v in por_funcao.most_common(10)},
            "por_local": {k: round(v, 2) for k, v in por_local.most_common(10)},
            "desde": "2023",
        }
        log(f"[emendas] {p['nome']}: {len(itens)} emendas")
    return {"emendas": saida}


# ------------------------------------------------------------------- TSE

def tse_am(ano: int) -> list[dict]:
    CACHE.mkdir(exist_ok=True)
    arq = CACHE / f"consulta_cand_{ano}_AM.csv"
    if not arq.exists():
        log(f"[tse] baixando candidaturas {ano}")
        z = zipfile.ZipFile(io.BytesIO(baixar(f"https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_{ano}.zip", timeout=600)))
        nome = next(n for n in z.namelist() if n.endswith("_AM.csv"))
        arq.write_bytes(z.read(nome))
    with arq.open(encoding="latin-1", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def eleito(x: dict) -> bool:
    return x["DS_SIT_TOT_TURNO"].startswith("ELEITO")


def coletar_executivo() -> dict:
    """Prefeitos eleitos em 2024 (TSE) + ajustes manuais com fonte."""
    manual = json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))
    substituidos = {sem_acento(m["municipio"]) for m in manual["titulares"] if m.get("municipio")}
    politicos = []
    for x in tse_am(2024):
        if x["DS_CARGO"] != "PREFEITO" or not eleito(x):
            continue
        if sem_acento(titulo(x["NM_UE"])) in substituidos:
            continue
        politicos.append({
            "id": f"tse-{x['SQ_CANDIDATO']}",
            "nome": titulo(x["NM_URNA_CANDIDATO"]),
            "nome_completo": titulo(x["NM_CANDIDATO"]),
            "cargo": "Prefeito(a)",
            "casa": "prefeituras",
            "esfera": "municipal",
            "partido": x["SG_PARTIDO"],
            "uf": "AM",
            "municipio": titulo(x["NM_UE"]),
            "foto": None,
            "email": None,
            "profissao": titulo(x["DS_OCUPACAO"]) if x["DS_OCUPACAO"] not in ("OUTROS", "#NULO") else None,
            "fonte": "https://dadosabertos.tse.jus.br/dataset/candidatos-2024",
            "periodo": "2025-01-01",
            "nota": "Eleito(a) em 2024 segundo o TSE.",
            "metricas": None,
        })
    for m in manual["titulares"]:
        politicos.append({**m, "metricas": None})
    log(f"[executivo] {len(politicos)} titulares")
    return {"politicos": politicos, "normas": []}


def coletar_eleitos_2026() -> list[dict]:
    cargos = {"GOVERNADOR": 1, "VICE-GOVERNADOR": 2, "SENADOR": 3, "DEPUTADO FEDERAL": 4, "DEPUTADO ESTADUAL": 5}
    saida = []
    for x in tse_am(2026):
        if x["DS_CARGO"] not in cargos or not eleito(x):
            continue
        saida.append({
            "cargo": titulo(x["DS_CARGO"]),
            "ordem": cargos[x["DS_CARGO"]],
            "nome": titulo(x["NM_URNA_CANDIDATO"]),
            "partido": x["SG_PARTIDO"],
            "situacao": titulo(x["DS_SIT_TOT_TURNO"]),
            "turno": x["NR_TURNO"],
        })
    saida.sort(key=lambda e: (e["ordem"], e["nome"]))
    log(f"[tse] {len(saida)} eleitos em 2026")
    return saida


# --------------------------------------------- Cota parlamentar (CEAP)

def resumo_cota(notas: list[dict]) -> dict:
    """Totais por categoria, mês e fornecedor de uma lista de notas."""
    cat, mes, forn = Counter(), Counter(), Counter()
    nome_forn = {}
    for n in notas:
        cat[n["categoria"]] += n["valor"]
        mes[f"{n['ano']}-{int(n['mes']):02d}"] += n["valor"]
        chave = n["cnpj"] or n["fornecedor"]
        forn[chave] += n["valor"]
        nome_forn[chave] = n["fornecedor"]
    return {
        "total": round(sum(n["valor"] for n in notas), 2),
        "notas": len(notas),
        "por_categoria": {k: round(v, 2) for k, v in cat.most_common()},
        "por_mes": {k: round(v, 2) for k, v in sorted(mes.items())},
        "fornecedores": [{"nome": nome_forn[k], "cnpj": k if k != nome_forn[k] else None, "valor": round(v, 2)} for k, v in forn.most_common(8)],
    }


def categoria_cota(texto: str) -> str:
    t = sem_acento(texto)
    regras = [
        ("Combustíveis", r"combust|lubrific"),
        ("Locação de veículos", r"loca.*veic|veicul"),
        ("Divulgação", r"divulg|informativ|folder|banner|outdoor|publicidade"),
        ("Consultoria e assessoria", r"consult|assess|pesquisa|trabalhos tecnicos"),
        ("Passagens e fretamento aéreo", r"passag|aere[ao]|aeronave|bilhete"),
        ("Escritório e manutenção", r"escritorio|imovel|aluguel|locacao de imovel|manutencao|material|condominio|energia|agua"),
        ("Telefonia e internet", r"telefon|internet|telecom"),
        ("Alimentação e hospedagem", r"aliment|hosped|refei"),
        ("Segurança", r"seguranca"),
        ("Postais", r"postal|correio"),
    ]
    for nome, padrao in regras:
        if re.search(padrao, t):
            return nome
    return titulo(texto.strip().rstrip(".")) or "Outros"


CMM_AJAX = "https://www.cmm.am.gov.br/wp-admin/admin-ajax.php"


def cmm_ajax(dados: dict):
    corpo = urllib.parse.urlencode(dados).encode()
    for i in range(3):
        try:
            req = urllib.request.Request(CMM_AJAX, data=corpo, headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            erro = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"SIGAE não respondeu: {erro}")


def coletar_ceap_cmm() -> dict:
    """Cota parlamentar dos vereadores de Manaus (SIGAE da CMM), de 2023 em diante."""
    vereadores = (ler("fontes/cmm.json") or {}).get("politicos", [])
    por_nome = {sem_acento(p["nome_completo"]): p["id"] for p in vereadores if p.get("nome_completo")}
    resumo, notas = {}, []
    for ano in range(2023, date.today().year + 1):
        lista = cmm_ajax({"action": "cmm_cotas_ceap_parlamentares", "ano": ano}).get("data") or []
        log(f"[ceap_cmm] {ano}: {len(lista)} gabinetes")

        def busca(p):
            r = cmm_ajax({"action": "cmm_cotas_ceap_fetch", "ano": ano, "modo": "sigae",
                          "mes_inicial": 1, "mes_final": 12, "parlamentar_id": p["id"]})
            return p, (r.get("data") if r.get("success") else None)

        with ThreadPoolExecutor(3) as ex:
            for p, d in ex.map(busca, lista):
                if not d:
                    continue
                pid = por_nome.get(sem_acento(p["nome"]))
                fin = d.get("financeiro") or {}
                minhas = []
                for n in d.get("notas") or []:
                    data = (n.get("data_emissao") or "")[:10]
                    minhas.append({
                        "casa": "cmm",
                        "politico": pid,
                        "politico_nome": titulo(p["nome"]),
                        "ano": ano,
                        "mes": int(data[5:7]) if data else 0,
                        "data": data,
                        "categoria": categoria_cota(n.get("item_despesa") or ""),
                        "fornecedor": (n.get("nome_fantasia") or n.get("fornecedor") or "").strip(),
                        "cnpj": n.get("cnpj") or None,
                        "valor": float(n.get("valor") or 0),
                        "documento": n.get("numero_documento"),
                    })
                notas += minhas
                if pid:
                    r = resumo_cota(minhas)
                    r["cota_disponivel"] = fin.get("total_disponivel")
                    r["cota_mensal"] = fin.get("cota_mensal")
                    r["uso"] = round(r["total"] / fin["total_disponivel"], 4) if fin.get("total_disponivel") else None
                    resumo.setdefault(pid, {})[str(ano)] = r
    log(f"[ceap_cmm] {len(notas)} notas")
    return {"cota": resumo, "notas": notas}


# ------------------------------------------------- Cota parlamentar da ALEAM

ALEAM_CEAP = "https://www.aleam.gov.br/transparencia/controle-de-cota-parlamentar/"
ALEAM_CSV = "https://www.aleam.gov.br/transparencia/wp-content/themes/transparencia/createCeap.php?"
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
         "Setembro", "Outubro", "Novembro", "Dezembro"]


def aleam_csv(pid: str, ano: int, mes: int) -> str | None:
    """CSV oficial de um gabinete num mês. A ALEAM responde 400 quando não há prestação de contas."""
    q = urllib.parse.urlencode({"parlamentar": pid, "parlamentarJaneiro": pid, "mes": MESES[mes - 1],
                                "ano": ano, "formato": "csv"})
    for i in range(3):
        try:
            req = urllib.request.Request(ALEAM_CSV + q, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8-sig", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(3 * (i + 1))
        except Exception:  # noqa: BLE001
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"ALEAM não respondeu: gabinete {pid}, {mes}/{ano}")


def coletar_ceap_aleam() -> dict:
    """Cota parlamentar (CEAP) dos deputados estaduais, pelo CSV do Portal da Transparência da ALEAM."""
    pagina = baixar(ALEAM_CEAP, timeout=120).decode("utf-8", "replace")
    gabinetes = {}
    for sel in ("dados", "dadosatual"):
        bloco = re.search(r'<select[^>]*id="%s"[^>]*>(.*?)</select>' % sel, pagina, re.S)
        for pid, nome in re.findall(r'<option value="(\d+)"\s*>([^<]+)</option>', bloco.group(1) if bloco else ""):
            gabinetes[pid] = html.unescape(nome).strip()
    if not gabinetes:
        raise RuntimeError("lista de gabinetes da ALEAM não encontrada")

    # Liga o gabinete ao político: primeiro pelo nome parlamentar, depois pelo nome civil do CSV
    politicos = (ler("fontes/aleam.json") or {}).get("politicos", [])
    politicos += [p for p in json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))["titulares"]
                  if p["casa"] == "governo"]
    por_nome = {}
    for p in politicos:
        por_nome[sem_acento(p["nome"]).replace("’", "'")] = p["id"]
        if p.get("nome_completo"):
            por_nome.setdefault(sem_acento(p["nome_completo"]), p["id"])

    hoje = date.today()
    tarefas = [(pid, ano, mes) for pid in gabinetes for ano in range(2023, hoje.year + 1)
               for mes in range(1, 13) if (ano, mes) <= (hoje.year, hoje.month)]
    with ThreadPoolExecutor(4) as ex:
        respostas = list(ex.map(lambda t: (t, aleam_csv(*t)), tarefas))

    notas, credito = [], defaultdict(float)
    for (pid, ano, mes), texto in respostas:
        if not texto or "Lote;" not in texto:
            continue
        cab, _, corpo = texto.partition("Lote;")
        civil = (re.search(r'Deputado\(a\);"?([^"\n]+)', cab) or [None, ""])[1].strip()
        cred = re.search(r'"?Verba Creditada"?;([\d.,]+)', cab)
        politico = por_nome.get(sem_acento(gabinetes[pid]).replace("’", "'")) or por_nome.get(sem_acento(civil))
        if politico and cred:
            credito[(politico, ano)] += valor(cred.group(1))
        for linha in csv.reader(io.StringIO("Lote;" + corpo), delimiter=";"):
            if len(linha) < 9 or linha[0] == "Lote" or not linha[8].strip():
                continue
            benef = linha[3].strip()
            doc, _, nome = benef.partition(" - ") if re.match(r"[\d./*-]+ - ", benef) else ("", "", benef)
            digitos = re.sub(r"\D", "", doc)
            emissao = linha[2].strip()
            iso = f"{emissao[6:10]}-{emissao[3:5]}-{emissao[0:2]}" if re.match(r"\d\d/\d\d/\d{4}", emissao) else ""
            notas.append({
                "casa": "aleam",
                "politico": politico,
                "politico_nome": gabinetes[pid],
                "ano": ano,
                "mes": mes,
                "data": iso,
                "categoria": categoria_cota(linha[4]),
                "fornecedor": nome.strip(),
                "cnpj": digitos if len(digitos) == 14 else None,
                "valor": valor(linha[8].strip()),
                "documento": linha[1].strip() or None,
            })

    resumo = {}
    for pid in {n["politico"] for n in notas if n["politico"]}:
        minhas = [n for n in notas if n["politico"] == pid]
        for ano in sorted({n["ano"] for n in minhas}):
            r = resumo_cota([n for n in minhas if n["ano"] == ano])
            disp = round(credito.get((pid, ano), 0), 2)
            r["cota_disponivel"] = disp or None
            r["uso"] = round(r["total"] / disp, 4) if disp else None
            resumo.setdefault(pid, {})[str(ano)] = r
    log(f"[ceap_aleam] {len(gabinetes)} gabinetes, {len(notas)} notas, {len(resumo)} ligados a políticos")
    return {"cota": resumo, "notas": notas}


# ------------------------------------------------------------ Diário Oficial

DIAS_DIARIO = 60       # janela de edições lidas a cada coleta
DIAS_MENCOES = 365     # menções guardadas
DOE = "https://diario.imprensaoficial.am.gov.br"

TIPOS_ATO = [
    ("Nomeação", r"\bnomea|\bnomear"),
    ("Exoneração", r"exonera"),
    ("Diárias e viagens", r"\bdiaria|viagem"),
    ("Licença", r"licenca"),
    ("Projeto de lei", r"projeto de lei"),
    ("Lei", r"(?<!projeto de )\blei (complementar |ordinaria )?n"),
    ("Requerimento", r"requerimento"),
    ("Indicação", r"\bindicacao"),
    ("Convênio ou emenda", r"convenio|termo de fomento|emenda parlamentar"),
    ("Decreto", r"\bdecreto"),
]


ASSINATURA = re.compile(r"\s*(?:[-–,]\s*)?(?:[a-z]+\s*)?(?:presidente|\d+[ºo°]? ?vice|vice-presidente|prefeit[oa]|secretari[oa]|governador|corregedor|ouvidor|diretor|lider|ordenador)")


def texto_pdf(conteudo: bytes) -> str | None:
    """Extrai o texto de um PDF com pdftotext (poppler ou xpdf); se não houver, tenta pypdf."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(conteudo)
        caminho = f.name
    try:
        if shutil.which("pdftotext"):
            r = subprocess.run(["pdftotext", "-enc", "UTF-8", caminho, "-"], capture_output=True, timeout=300)
            if r.returncode == 0:
                return r.stdout.decode("utf-8", "replace")
        try:
            from pypdf import PdfReader  # opcional
            return "\n".join((p.extract_text() or "") for p in PdfReader(caminho).pages)
        except ImportError:
            return None
    finally:
        Path(caminho).unlink(missing_ok=True)


def edicoes_aleam(desde: date) -> list[dict]:
    saida = []
    for pagina in range(1, 15):
        corpo = baixar(f"https://www.aleam.gov.br/diario/?cpage={pagina}", timeout=120).decode("utf-8", "replace")
        achou = re.findall(r'href="([^"]+\.pdf)"[^>]*>\s*Edição nº\s*(\d+)\s*</a>.*?cont-header-date">\s*(\d\d)/(\d\d)/(\d{4})', corpo, re.S)
        for url, num, d, m, a in achou:
            saida.append({"fonte": "aleam", "nome": "Diário Oficial Eletrônico da ALEAM", "numero": num,
                          "data": f"{a}-{m}-{d}", "url": url})
        if not achou or min(f"{a}-{m}-{d}" for _, _, d, m, a in achou) < desde.isoformat():
            break
    return [e for e in {e["url"]: e for e in saida}.values() if e["data"] >= desde.isoformat()]


def edicoes_cmm(desde: date) -> list[dict]:
    itens = jget(f"https://www.cmm.am.gov.br/wp-json/wp/v2/diario-oficial?per_page=60&after={desde.isoformat()}T00:00:00", timeout=120)
    saida = []
    for it in itens:
        midia = jget(f"https://www.cmm.am.gov.br/wp-json/wp/v2/media?parent={it['id']}", timeout=120)
        pdf = next((m["source_url"] for m in midia if m.get("mime_type") == "application/pdf"), None)
        if pdf:
            saida.append({"fonte": "cmm", "nome": "Diário Oficial Eletrônico da CMM",
                          "numero": html.unescape(it["title"]["rendered"]), "data": it["date"][:10], "url": pdf})
    return saida


def edicoes_doe(desde: date) -> list[dict]:
    saida, dia = [], desde
    while dia <= date.today():
        if dia.weekday() < 5:
            r = jget(f"{DOE}/apifront/portal/edicoes/edicoes_from_data/{dia.isoformat()}.json", timeout=60)
            for it in r.get("itens") or []:
                extra = f" · {it['suplemento_nome']}" if it.get("suplemento_nome") else (" · suplemento" if it.get("suplemento") else "")
                saida.append({"fonte": "doe", "nome": "Diário Oficial do Estado do Amazonas" + extra,
                              "numero": str(it["numero"]), "data": dia.isoformat(),
                              "url": f"{DOE}/portal/edicoes/download/{it['id']}"})
        dia += timedelta(days=1)
    return saida


def padroes_nome(p: dict, fonte: str) -> list[str]:
    """Formas de achar o político no texto, já sem acento e em minúsculas."""
    nome = re.sub(r"\s+", " ", sem_acento(p["nome"]).replace("’", "'")).strip()
    sem_titulo = re.sub(r"^(dra?\.?|delegad[oa]|comandante|cabo|capitao|coronel|pastor[a]?|professor[a]?) ", "", nome)
    cargos = {"aleam": r"deputad[oa]", "camara": r"deputad[oa]", "cmm": r"vereador[a]?", "senado": r"senador[a]?",
              "prefeituras": r"prefeit[oa]", "governo": r"vice-governador[a]?|governador[a]?"}
    pads = [r"\b(?:%s)(?: (?:estadual|federal|municipal))? %s\b" % (cargos.get(p["casa"], "x^"), re.escape(nome))]
    if sem_titulo != nome:
        pads.append(r"\b(?:%s) %s\b" % (cargos.get(p["casa"], "x^"), re.escape(sem_titulo)))
    civil = sem_acento(p.get("nome_completo") or "")
    if len(civil.split()) >= 3:
        pads.append(r"\b%s\b" % re.escape(civil))
    # No diário da própria casa o nome parlamentar sozinho é seguro quando tem duas palavras ou mais,
    # desde que não seja o começo de um nome mais longo (ex.: um servidor homônimo "Felipe Souza dos Santos")
    if fonte == p["casa"] and len(nome.split()) >= 2:
        pads.append(r"\b%s\b(?! (?:d[aeo]s?|e) \w)" % re.escape(nome))
    return pads


def tipo_ato(antes: str, depois: str) -> str:
    """Tipo do ato: a palavra-chave mais próxima antes do nome; se não houver, a primeira logo depois."""
    melhor, pos = None, -1
    for nome, padrao in TIPOS_ATO:
        for m in re.finditer(padrao, antes):
            if m.start() > pos:
                melhor, pos = nome, m.start()
    if melhor:
        return melhor
    for nome, padrao in TIPOS_ATO:
        if re.search(padrao, depois):
            return nome
    return "Menção"


def coletar_diarios() -> dict:
    """Menções aos políticos nos diários oficiais da ALEAM, da CMM e do Estado (DOE-AM)."""
    if not shutil.which("pdftotext"):
        try:
            import pypdf  # noqa: F401
        except ImportError:
            raise RuntimeError("instale o pdftotext (pacote poppler-utils) ou o pypdf para ler os diários")
    ant = ler("fontes/diarios.json") or {}
    lidas = {e["url"]: e for e in ant.get("edicoes", [])}
    hoje = date.today()
    desde = hoje - timedelta(days=DIAS_DIARIO)

    edicoes = []
    for nome, fn in (("aleam", edicoes_aleam), ("cmm", edicoes_cmm), ("doe", edicoes_doe)):
        try:
            e = fn(desde)
            edicoes += e
            log(f"[diarios] {nome}: {len(e)} edições desde {desde}")
        except Exception as erro:  # noqa: BLE001
            log(f"[diarios] {nome} FALHOU: {erro}")

    politicos = []
    for chave in ("cmm", "aleam", "camara", "senado", "prefeituras"):
        politicos += (ler(f"fontes/{chave}.json") or {}).get("politicos", [])
    politicos += json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))["titulares"]
    # Governador e vice assinam quase todo ato do DOE; ali não entram
    alvos = {f: [(p, re.compile("|".join(padroes_nome(p, f)))) for p in politicos
                 if not (f == "doe" and p["casa"] == "governo")] for f in ("aleam", "cmm", "doe")}
    formas = {re.sub(r"\s+", " ", sem_acento(p["nome"]).replace("’", "'")) for p in politicos if len(p["nome"]) > 5}
    formas |= {sem_acento(p["nome_completo"]) for p in politicos if len((p.get("nome_completo") or "").split()) >= 3}
    todos_nomes = re.compile("|".join(sorted(map(re.escape, formas), key=len, reverse=True)))

    mencoes = [m for m in ant.get("mencoes", []) if m["data"] >= (hoje - timedelta(days=DIAS_MENCOES)).isoformat()]
    novas = [e for e in edicoes if e["url"] not in lidas]
    log(f"[diarios] {len(novas)} edições novas para ler")

    def ler_edicao(e):
        try:
            return e, texto_pdf(baixar(e["url"], timeout=300))
        except Exception as erro:  # noqa: BLE001
            log(f"[diarios] {e['url']}: {erro}")
            return e, None

    with ThreadPoolExecutor(3) as ex:
        for e, texto in ex.map(ler_edicao, novas):
            if texto is None:
                continue
            texto = re.sub(r"-\n(?=\w)", "", texto)
            texto = re.sub(r"<#[^>]*>", " ", texto)  # marcadores internos do DOE
            texto = re.sub(r"\s+", " ", texto)
            norm = sem_acento(texto).replace("’", "'")
            if len(norm) != len(texto):
                texto = norm
            achadas = 0
            for p, rx in alvos[e["fonte"]]:
                vistos = 0
                for m in rx.finditer(norm):
                    ini, fim = max(0, m.start() - 260), min(len(norm), m.end() + 260)
                    # Assinatura de ofício (presidente, prefeito, secretário) não é notícia sobre o político
                    if ASSINATURA.match(norm, m.end()) or re.search(r"presidente:? ?$", norm[max(0, m.start() - 40):m.start()]):
                        continue
                    # Listas de nomes (expediente, Mesa, comissões, chamadas) não contam
                    if len(set(todos_nomes.findall(norm[max(0, m.start() - 180):m.end() + 180]))) >= 3:
                        continue
                    trecho = texto[ini:fim].strip()
                    mencoes.append({"politico": p["id"], "politico_nome": p["nome"], "fonte": e["fonte"],
                                    "diario": e["nome"], "edicao": e["numero"], "data": e["data"], "url": e["url"],
                                    "tipo": tipo_ato(norm[max(0, m.start() - 160):m.start()], norm[m.end():m.end() + 60]), "trecho": ("…" if ini else "") + trecho + ("…" if fim < len(norm) else "")})
                    achadas += 1
                    vistos += 1
                    if vistos >= 3:
                        break
            lidas[e["url"]] = {**e, "mencoes": achadas, "lida_em": HOJE}

    janela = {e["url"] for e in edicoes}
    lista = sorted([e for u, e in lidas.items() if u in janela or e["data"] >= desde.isoformat()],
                   key=lambda e: (e["data"], e["fonte"]), reverse=True)
    mencoes.sort(key=lambda m: m["data"], reverse=True)
    log(f"[diarios] {len(lista)} edições na janela, {len(mencoes)} menções guardadas")
    return {"edicoes": lista, "mencoes": mencoes}


def coletar_camara_atividade() -> dict:
    """Cota, presença em sessões e votações dos deputados federais do AM (arquivos da Câmara)."""
    deps = (ler("fontes/camara.json") or {}).get("politicos", [])
    ids = {p["id"].split("-")[1]: p["id"] for p in deps}
    partido = {p["id"]: p.get("partido") for p in deps}
    nomes = {p["id"]: p["nome"] for p in deps}
    arq = "https://dadosabertos.camara.leg.br/arquivos"

    def csv_url(url, zipado=False):
        b = baixar(url, timeout=600)
        if zipado:
            z = zipfile.ZipFile(io.BytesIO(b))
            b = z.read(z.namelist()[0])
        return list(csv.DictReader(io.StringIO(b.decode("utf-8-sig")), delimiter=";"))

    resumo, notas = {}, []
    presenca = {pid: {} for pid in ids.values()}
    votos = {pid: [] for pid in ids.values()}
    for ano in range(2023, date.today().year + 1):
        # Cota parlamentar (CPF não é guardado)
        for r in csv_url(f"https://www.camara.leg.br/cotas/Ano-{ano}.csv.zip", zipado=True):
            pid = ids.get(r.get("ideCadastro"))
            if not pid:
                continue
            valor_n = float((r.get("vlrLiquido") or "0").replace(",", ".") or 0)
            notas.append({
                "casa": "camara", "politico": pid, "politico_nome": nomes[pid], "ano": ano,
                "mes": int(r.get("numMes") or 0), "data": (r.get("datEmissao") or "")[:10],
                "categoria": categoria_cota(r.get("txtDescricao") or ""),
                "fornecedor": (r.get("txtFornecedor") or "").strip(),
                "cnpj": re.sub(r"\D", "", r.get("txtCNPJCPF") or "") or None if len(re.sub(r"\D", "", r.get("txtCNPJCPF") or "")) == 14 else None,
                "valor": valor_n, "documento": r.get("txtNumero"),
            })
        log(f"[camara_atividade] cota {ano}")

        # Presença em sessões deliberativas do Plenário
        sessoes = {e["id"] for e in csv_url(f"{arq}/eventos/csv/eventos-{ano}.csv")
                   if "sessao deliberativa" in sem_acento(e.get("descricaoTipo", "")) and "encerrada" in sem_acento(e.get("situacao", ""))}
        presentes = Counter()
        for e in csv_url(f"{arq}/eventosPresencaDeputados/csv/eventosPresencaDeputados-{ano}.csv"):
            if e["idEvento"] in sessoes and e["idDeputado"] in ids:
                presentes[ids[e["idDeputado"]]] += 1
        for pid in presenca:
            presenca[pid][str(ano)] = {"presente": presentes[pid], "sessoes": len(sessoes)}

        # Votações nominais no Plenário. A orientação oficial vem por bloco com nome
        # truncado ("Bl PlFdrPtUniPp..."), então a referência é a maioria do próprio
        # partido naquela votação, sem contar o voto do deputado.
        plen = {v["id"]: v for v in csv_url(f"{arq}/votacoes/csv/votacoes-{ano}.csv") if v.get("siglaOrgao") == "PLEN"}
        placar = defaultdict(Counter)
        meus = []
        for v in csv_url(f"{arq}/votacoesVotos/csv/votacoesVotos-{ano}.csv"):
            if v["idVotacao"] not in plen:
                continue
            sigla = (v.get("deputado_siglaPartido") or "").upper()
            if v.get("voto") in ("Sim", "Não"):
                placar[(v["idVotacao"], sigla)][v["voto"]] += 1
            pid = ids.get(v.get("deputado_id"))
            if pid:
                meus.append((pid, sigla or (partido[pid] or "").upper(), v))
        for pid, sigla, v in meus:
            info = plen[v["idVotacao"]]
            outros = Counter(placar[(v["idVotacao"], sigla)])
            if v.get("voto") in ("Sim", "Não"):
                outros[v["voto"]] -= 1
            maioria = None
            if outros["Sim"] + outros["Não"] >= 2 and outros["Sim"] != outros["Não"]:
                maioria = "Sim" if outros["Sim"] > outros["Não"] else "Não"
            votos[pid].append({
                "id": v["idVotacao"], "data": (v.get("dataHoraVoto") or info.get("data") or "")[:10],
                "voto": v.get("voto"), "partido": sigla, "maioria_partido": maioria,
                "aprovada": info.get("aprovacao") == "1",
                "descricao": re.sub(r"\s+", " ", info.get("descricao") or "")[:220],
                "proposicao": info.get("ultimaApresentacaoProposicao_descricao") or None,
            })
        log(f"[camara_atividade] presença e votos {ano}")

    for pid in ids.values():
        minhas = [n for n in notas if n["politico"] == pid]
        por_ano = {}
        for ano in sorted({n["ano"] for n in minhas}):
            por_ano[str(ano)] = resumo_cota([n for n in minhas if n["ano"] == ano])
        vs = sorted(votos[pid], key=lambda x: x["data"], reverse=True)
        com_orient = [x for x in vs if x["maioria_partido"] and x["voto"] in ("Sim", "Não")]
        resumo[pid] = {
            "cota": por_ano,
            "presenca": presenca[pid],
            "votos": {
                "total": len(vs),
                "sim": sum(1 for x in vs if x["voto"] == "Sim"),
                "nao": sum(1 for x in vs if x["voto"] == "Não"),
                "com_orientacao": len(com_orient),
                "seguiu_partido": sum(1 for x in com_orient if x["voto"] == x["maioria_partido"]),
                "recentes": vs[:40],
            },
        }
    log(f"[camara_atividade] {len(notas)} notas de cota")
    return {"atividade": resumo, "notas": notas}


def coletar_eleicoes() -> dict:
    """Votos e patrimônio declarado ao TSE, na eleição mais recente de cada político.

    Arquivos grandes (até 600 MB). Rode à mão após cada eleição:
        python scripts/coletar.py eleicoes
    """
    politicos = [p for f in ("cmm", "aleam", "camara", "senado", "prefeituras") for p in (ler(f"fontes/{f}.json") or {}).get("politicos", [])]
    base = "https://cdn.tse.jus.br/estatistica/sead/odsele"

    def arquivo_am(pasta: str, nome: str, ano: int) -> Path:
        CACHE.mkdir(exist_ok=True)
        destino = CACHE / f"{nome}_{ano}_AM.csv"
        if not destino.exists():
            log(f"[eleicoes] baixando {nome} {ano}")
            tmp = CACHE / f"{nome}_{ano}.zip"
            if not tmp.exists():
                req = urllib.request.Request(f"{base}/{pasta}/{nome}_{ano}.zip", headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=1800) as r, tmp.open("wb") as f:
                    while True:
                        bloco = r.read(1 << 20)
                        if not bloco:
                            break
                        f.write(bloco)
            with zipfile.ZipFile(tmp) as z:
                membro = next(n for n in z.namelist() if n.endswith("_AM.csv"))
                destino.write_bytes(z.read(membro))
            tmp.unlink()
        return destino

    def ler_csv(p: Path):
        with p.open(encoding="latin-1", newline="") as f:
            yield from csv.DictReader(f, delimiter=";")

    cargos_por_casa = {
        "cmm": {2024: ["VEREADOR"]},
        "prefeituras": {2024: ["PREFEITO", "VICE-PREFEITO"]},
        "aleam": {2026: ["DEPUTADO ESTADUAL", "DEPUTADO FEDERAL", "SENADOR", "GOVERNADOR", "VICE-GOVERNADOR"], 2022: ["DEPUTADO ESTADUAL"]},
        "camara": {2026: ["DEPUTADO FEDERAL", "SENADOR", "GOVERNADOR", "VICE-GOVERNADOR", "DEPUTADO ESTADUAL"], 2022: ["DEPUTADO FEDERAL"]},
        "senado": {2026: ["SENADOR", "GOVERNADOR", "VICE-GOVERNADOR", "DEPUTADO FEDERAL"], 2022: ["SENADOR"]},
        "governo": {2026: ["GOVERNADOR", "VICE-GOVERNADOR", "SENADOR", "DEPUTADO ESTADUAL", "DEPUTADO FEDERAL"], 2022: ["DEPUTADO ESTADUAL", "GOVERNADOR", "VICE-GOVERNADOR"], 2024: ["PREFEITO", "VICE-PREFEITO", "VEREADOR"]},
    }
    anos = sorted({a for c in cargos_por_casa.values() for a in c}, reverse=True)
    cand, bens, votos = {}, Counter(), Counter()
    for ano in anos:
        cand[ano] = [x for x in tse_am(ano)]
        try:
            for b in ler_csv(arquivo_am("bem_candidato", "bem_candidato", ano)):
                bens[(ano, b["SQ_CANDIDATO"])] += float((b.get("VR_BEM_CANDIDATO") or "0").replace(",", ".") or 0)
        except Exception as e:  # noqa: BLE001
            log(f"[eleicoes] bens {ano}: {e}")
        try:
            for v in ler_csv(arquivo_am("votacao_candidato_munzona", "votacao_candidato_munzona", ano)):
                votos[(ano, v["SQ_CANDIDATO"], v["NR_TURNO"])] += int(v.get("QT_VOTOS_NOMINAIS") or 0)
        except Exception as e:  # noqa: BLE001
            log(f"[eleicoes] votos {ano}: {e}")

    saida = {}
    for p in politicos:
        regras = cargos_por_casa.get(p["casa"], {})
        nomes = {sem_acento(p["nome"]), sem_acento(p.get("nome_completo") or "")} - {""}
        achou = None
        for ano in sorted(regras, reverse=True):
            for x in cand.get(ano, []):
                if x["DS_CARGO"] not in regras[ano]:
                    continue
                if p.get("municipio") and ano == 2024 and sem_acento(x["NM_UE"]) != sem_acento(p["municipio"]):
                    continue
                if sem_acento(x["NM_URNA_CANDIDATO"]) in nomes or sem_acento(x["NM_CANDIDATO"]) in nomes:
                    if x["DS_SITUACAO_CANDIDATURA"] == "INAPTO" and achou:
                        continue
                    achou = (ano, x)
                    if x["DS_SITUACAO_CANDIDATURA"] != "INAPTO":
                        break
            if achou:
                break
        if not achou:
            continue
        ano, x = achou
        turnos = {t: votos[(ano, x["SQ_CANDIDATO"], t)] for t in ("1", "2") if votos[(ano, x["SQ_CANDIDATO"], t)]}
        saida[p["id"]] = {
            "ano": ano,
            "cargo": titulo(x["DS_CARGO"]),
            "partido": x["SG_PARTIDO"],
            "numero": x["NR_CANDIDATO"],
            "situacao": titulo(x["DS_SIT_TOT_TURNO"]),
            "votos": turnos.get("2") or turnos.get("1"),
            "patrimonio": round(bens[(ano, x["SQ_CANDIDATO"])], 2) if (ano, x["SQ_CANDIDATO"]) in bens else None,
            "nascimento": x.get("DT_NASCIMENTO") or None,
            "instrucao": titulo(x.get("DS_GRAU_INSTRUCAO") or "") or None,
            "ocupacao": titulo(x.get("DS_OCUPACAO") or "") or None,
            "fonte": f"https://divulgacandcontas.tse.jus.br/",
        }
    log(f"[eleicoes] {len(saida)} de {len(politicos)} políticos encontrados no TSE")
    return {"eleicoes": saida}


# ------------------------------------------------------------------ main

FONTES_INFO = {
    "cmm": ("Câmara Municipal de Manaus (SAPL)", "https://sapl.cmm.am.gov.br"),
    "aleam": ("Assembleia Legislativa do Amazonas (SAPL)", "https://sapl.al.am.leg.br"),
    "camara": ("Câmara dos Deputados — Dados Abertos", "https://dadosabertos.camara.leg.br"),
    "senado": ("Senado Federal — Dados Abertos", "https://legis.senado.leg.br/dadosabertos"),
    "prefeituras": ("TSE — Candidaturas 2024 e ajustes com fonte", "https://dadosabertos.tse.jus.br"),
    "emendas": ("Portal da Transparência — Emendas parlamentares", "https://portaldatransparencia.gov.br/emendas"),
    "ceap_cmm": ("Câmara Municipal de Manaus — Cota parlamentar (SIGAE)", "https://www.cmm.am.gov.br/transparencia/#cotas-ceap"),
    "camara_atividade": ("Câmara dos Deputados — Cota, presença e votações", "https://dadosabertos.camara.leg.br/swagger/api.html#staticfile"),
    "eleicoes": ("TSE — Votos e bens declarados", "https://dadosabertos.tse.jus.br"),
    "ceap_aleam": ("Assembleia Legislativa do Amazonas — Cota parlamentar (CEAP)", "https://www.aleam.gov.br/transparencia/controle-de-cota-parlamentar/"),
    "diarios": ("Diários oficiais: ALEAM, Câmara Municipal de Manaus e Estado do Amazonas", "https://diario.imprensaoficial.am.gov.br"),
}
# Fontes pesadas que só rodam quando pedidas pelo nome
SOB_DEMANDA = {"eleicoes"}


def main() -> int:
    tarefas = {
        "cmm": lambda: coletar_sapl("cmm", "https://sapl.cmm.am.gov.br", "Vereador(a) de Manaus", "municipal", "Manaus"),
        "aleam": lambda: coletar_sapl("aleam", "https://sapl.al.am.leg.br", "Deputado(a) estadual", "estadual", None),
        "camara": coletar_camara,
        "senado": coletar_senado,
        "prefeituras": coletar_executivo,
        "emendas": coletar_emendas,  # depende de camara e senado
        "ceap_cmm": coletar_ceap_cmm,  # depende de cmm
        "camara_atividade": coletar_camara_atividade,  # depende de camara
        "ceap_aleam": coletar_ceap_aleam,  # depende de aleam
        "diarios": coletar_diarios,  # depende das casas
        "eleicoes": coletar_eleicoes,  # sob demanda
    }
    meta_ant = ler("meta.json", {}) or {}
    fontes_meta = {f["id"]: f for f in meta_ant.get("fontes", [])}
    falhas = []
    escolhidas = set(sys.argv[1:]) or (set(tarefas) - SOB_DEMANDA)
    for chave, fn in tarefas.items():
        if chave not in escolhidas:
            continue
        try:
            resultado = fn()
            salvar(f"fontes/{chave}.json", resultado)
            nome, url = FONTES_INFO[chave]
            fontes_meta[chave] = {"id": chave, "nome": nome, "url": url, "atualizado_em": HOJE,
                                  "legislatura": resultado.get("legislatura")}
        except Exception as e:  # noqa: BLE001
            falhas.append(chave)
            log(f"[{chave}] FALHOU: {e} — mantendo dados anteriores")

    try:
        if "prefeituras" in escolhidas or not (DADOS / "eleitos-2026.json").exists():
            salvar("eleitos-2026.json", coletar_eleitos_2026())
    except Exception as e:  # noqa: BLE001
        log(f"[tse 2026] FALHOU: {e}")

    # Junta as fontes num único arquivo de políticos e um de normas
    politicos, normas = [], []
    for chave in tarefas:
        dados = ler(f"fontes/{chave}.json")
        if dados and "politicos" in dados:
            politicos += dados["politicos"]
            normas += dados["normas"]
    emendas = (ler("fontes/emendas.json") or {}).get("emendas", {})
    ceap_cmm = ler("fontes/ceap_cmm.json") or {}
    atividade = ler("fontes/camara_atividade.json") or {}
    eleicoes = (ler("fontes/eleicoes.json") or {}).get("eleicoes", {})
    ceap_aleam = ler("fontes/ceap_aleam.json") or {}
    diarios = ler("fontes/diarios.json") or {}
    por_politico = defaultdict(list)
    for m in diarios.get("mencoes", []):
        por_politico[m["politico"]].append(m)
    for p in politicos:
        if p["id"] in emendas:
            p["emendas"] = emendas[p["id"]]
        if p["id"] in ceap_cmm.get("cota", {}):
            p["cota"] = ceap_cmm["cota"][p["id"]]
        if p["id"] in atividade.get("atividade", {}):
            a = atividade["atividade"][p["id"]]
            p["cota"] = a["cota"]
            p["presenca"] = a["presenca"]
            p["votacoes"] = a["votos"]
        if p["id"] in eleicoes:
            p["eleicao"] = eleicoes[p["id"]]
        if p["id"] in ceap_aleam.get("cota", {}) and "cota" not in p:
            p["cota"] = ceap_aleam["cota"][p["id"]]
        if por_politico.get(p["id"]):
            ms = por_politico[p["id"]]
            p["diario"] = {"total": len(ms), "por_tipo": dict(Counter(m["tipo"] for m in ms).most_common()),
                           "recentes": [{k: m[k] for k in ("diario", "edicao", "data", "url", "tipo", "trecho")} for m in ms[:8]]}
    # Notas fiscais da cota, das duas casas, num arquivo próprio (só a página de gastos carrega)
    salvar("diario.json", {"edicoes": diarios.get("edicoes", []), "mencoes": diarios.get("mencoes", [])})
    salvar("gastos.json", sorted(ceap_cmm.get("notas", []) + atividade.get("notas", []) + ceap_aleam.get("notas", []),
                                 key=lambda n: n.get("data") or "", reverse=True))
    normas.sort(key=lambda n: n.get("data") or "", reverse=True)
    executivo = json.loads((DADOS / "executivo-manual.json").read_text(encoding="utf-8"))
    salvar("politicos.json", politicos)
    salvar("normas.json", normas)
    salvar("meta.json", {
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fontes": list(fontes_meta.values()),
        "ajustes_executivo": executivo.get("fontes", []),
        "falhas": falhas,
        "totais": {"politicos": len(politicos), "normas": len(normas)},
    })
    log(f"OK: {len(politicos)} políticos, {len(normas)} normas. Falhas: {falhas or 'nenhuma'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
