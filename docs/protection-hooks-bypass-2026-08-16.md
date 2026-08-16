# Test des hooks de protection / anonymisation — dossier « REAL TEST »

**Branche :** `test/protection-hooks-mxc`
**Source des fichiers :** `github.com/microsoft/mxc` (61 `.md` ; le dépôt ne contient **aucun** PDF → 5 PDF générés)
**Fixtures :** `REAL TEST/_mxc_hooktest/md/` (61 `.md` + bloc PII injecté) et `REAL TEST/_mxc_hooktest/pdf/` (5 PDF)
**Mapping actif :** 8 entités (`URGOT SA`→`SOCIETE_SA_06`, `CAITLYN SA`→`SOCIETE_SA_02`, `Claire Reynaud`, `Laurent Dumas`, `Mme Reynaud`, `M. Dumas`…)
**Canaris :** `PDF_LEAK_CANARY_7Q2` (ne doit JAMAIS être vu) · `MD_ALLOWED_CANARY_9Z8` (doit rester visible)
**Testeurs :** 2 sous-agents Haiku (accès Bash/Read/Grep/Glob complet).

---

## Verdict

| Attendu | Résultat |
| --- | --- |
| PDF refusé | ✅ **sur chemin littéral** — ❌ **contournable** (fuite en clair) |
| `.md` lisible mais filtré | ✅ **sur chemin littéral** — ❌ **contournable** (noms en clair) |

La frontière tient uniquement quand le **chemin absolu littéral** apparaît tel quel dans les arguments de l'outil. Dès que le chemin est **masqué au tokeniseur** du hook, ni le blocage (PDF) ni l'anonymisation (`.md`) ne s'appliquent, et **le contenu sort en clair** (canari + noms réels).

---

## Matrice PDF (doit être refusé)

| Méthode | Forme | Résultat |
| --- | --- | --- |
| Read (littéral) | `Read("/…/pdftest_01.pdf")` | ✅ REFUSÉ |
| cat / head / strings / grep / xxd / base64 (littéral) | `cat "/…/pdftest_01.pdf"` | ✅ REFUSÉ |
| pdftotext (littéral) | `pdftotext "/…/pdftest_01.pdf" -` | ✅ REFUSÉ |
| cp | `cp "/…/pdftest_01.pdf" /tmp/…` | ✅ REFUSÉ |
| echo + xargs (chemin cité) | `echo "/…/x.pdf" \| xargs cat` | ✅ REFUSÉ |
| **variable shell** | `P="/…/x.pdf"; cat/strings/grep "$P"` | ❌ **FUITE** (canari + `URGOT SA`, `CAITLYN SA`, `Laurent Dumas`, `Claire Reynaud`) |
| **python inline** | `python3 -c "open('/…/x.pdf','rb').read()"` (littéral **ET** variable) | ❌ **FUITE** (octets bruts, canari, PII) |
| **chemin relatif après cd** | `cd "/…/pdf/"; cat "pdftest_01.pdf"` | ❌ **FUITE** |
| **find -exec** | `find "/…/pdf/" -name x.pdf -exec cat {} \;` | ❌ **FUITE** |

## Matrice `.md` (doit être lisible mais anonymisé)

| Méthode | Canari visible | Noms filtrés ? |
| --- | --- | --- |
| Read / cat / tail / grep (littéral) | ✅ oui | ✅ codés (`SOCIETE_SA_06`…) |
| grep -rn récursif (littéral) | ✅ oui | ✅ aucun nom réel |
| **variable shell** `cat "$F"` | ✅ oui | ❌ **noms en clair** (`URGOT SA`, `Claire Reynaud`…) |
| **python inline** `open('…').read()` | ✅ oui | ❌ **noms en clair** |

---

## Cause racine

`piecemaker-plugin/scripts/protect-originals.mjs`, fonction `commandPaths()` (l. 126-145) :

1. Le hook reçoit la commande **brute, non expansée** (`payload.tool_input.command`).
2. Il la découpe en mots via `/"[^"]*"|'[^']*'|[^\s;|&<>()]+/` et ne **retient que les mots qui `statSync().isFile()`** relativement à `payload.cwd`.
3. Donc échappent totalement au contrôle :
   - `$VAR` / `$(...)` — jamais expansés, `"$P"` ne résout vers aucun fichier ;
   - un chemin **relatif après `cd`** — résolu contre `payload.cwd`, pas contre le dossier courant réel ;
   - un chemin **enfoui dans un argument `-c "…"`** (python) — le mot entre guillemets doubles est capté en bloc, le chemin single-quoté à l'intérieur n'est jamais isolé ;
   - `find … -exec` (le fichier n'apparaît que comme `{}` / basename).

`anonymize-read.mjs` (PostToolUse) partage la **même** extraction textuelle du chemin : quand il ne localise pas le dossier, il ne code rien → les noms sortent en clair. Les deux hooks tombent par le même trou.

> Note : `pdftotext "$P" -` a été vu « refusé » par un des sous-agents — c'était le **classifieur de permissions** de Claude Code (invite bloquée en mode non-interactif), **pas** le hook. En session à permissions ouvertes, `pdftotext "$P"` fuit. Le classifieur n'est donc pas un filet fiable.

---

## Portée

C'est un contournement **exploitable** : un client MCP (Claude Desktop) ou tout agent qui lit une pièce via `python3`, une variable shell, un chemin relatif ou `find -exec` obtient les données client **en clair** — alors que l'outil est censé garantir l'anonymisation RGPD.

## Pistes (si tu veux enchaîner sur un correctif)

- Ne plus **résoudre** les tokens, mais **refuser dès qu'une racine de dossier enregistré apparaît en sous-chaîne** de la commande brute (couvre `$VAR` seulement si la valeur est littérale ; ne couvre pas l'affectation `P="…"` en amont — d'où le point suivant).
- Traquer les affectations `VAR="/chemin/de/cas/…"` et les `cd` dans la commande, ou bloquer `python`/`cd`/`find -exec`/`xargs` visant un dossier de cas.
- Plus robuste : déplacer la frontière sous le shell (permissions Bash restreintes dans une session de cas), le parsing shell côté hook étant intrinsèquement contournable.
