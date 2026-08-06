#!/usr/bin/env node
/**
 * Check the substitution rules against the criterion the plan set for them:
 * "on GENSIGHT, zero substitution inside a word — exactly verifiable".
 *
 * Runs the REAL helpers exported by anonymization-server.cjs over a real document and a
 * real sensitive_map, and counts how many replacements land inside another word. The old
 * rule (`new RegExp(escapeRegex(x), 'gi')`, arbitrary order) is replayed on the same input
 * so the fix is quantified rather than asserted.
 *
 *   node verify_substitution.cjs <document.md> <document_sensitive_map.json>
 */
const fs = require('fs');
const path = require('path');

const MOD = path.resolve(__dirname, '../../../../taskpane/modules/anonymization-server.cjs');
const { buildEntityRegex, byDescendingEntityLength } = require(MOD);

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD = /[\p{L}\p{N}_]/u;

/** A match is "inside a word" when a word character touches either edge in the source. */
function countInWord(text, regex) {
    let total = 0;
    let inWord = 0;
    const samples = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        total++;
        const before = m.index > 0 ? text[m.index - 1] : '';
        const after = text[m.index + m[0].length] || '';
        if ((before && WORD.test(before)) || (after && WORD.test(after))) {
            inWord++;
            if (samples.length < 6) {
                samples.push(text.slice(Math.max(0, m.index - 18), m.index + m[0].length + 18)
                    .replace(/\s+/g, ' '));
            }
        }
    }
    return { total, inWord, samples };
}

function main() {
    const [docPath, mapPath] = process.argv.slice(2);
    const text = fs.readFileSync(docPath, 'utf8');
    const payload = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

    // The map is keyed by entity type, each holding occurrences; substitution works from
    // the distinct entity strings.
    const entities = new Set();
    for (const items of Object.values(payload.entities)) {
        for (const e of items) if (e.text) entities.add(e.text);
    }
    const list = [...entities];
    console.log(`document : ${path.basename(docPath)} — ${text.split(/\s+/).length} mots`);
    console.log(`entités distinctes dans le sensitive_map : ${list.length}\n`);

    // --- ancienne règle -----------------------------------------------------------
    let oldTotal = 0, oldInWord = 0;
    const worst = [];
    for (const ent of list) {
        const r = countInWord(text, new RegExp(escapeRegex(ent), 'gi'));
        oldTotal += r.total;
        oldInWord += r.inWord;
        if (r.inWord > 0) worst.push({ ent, inWord: r.inWord, sample: r.samples[0] });
    }

    // --- règle actuelle -----------------------------------------------------------
    let newTotal = 0, newInWord = 0, skipped = 0;
    const offenders = [];
    const neverMatched = [];   // détectée mais jamais substituée = fuite de PII réelle
    const skippedList = [];
    for (const ent of [...list].sort(byDescendingEntityLength(x => x))) {
        const rx = buildEntityRegex(ent);
        if (!rx) { skipped++; skippedList.push(ent); continue; }
        const r = countInWord(text, rx);
        newTotal += r.total;
        newInWord += r.inWord;
        if (r.total === 0) neverMatched.push(ent);
        if (r.inWord > 0) offenders.push({ ent, inWord: r.inWord, samples: r.samples });
    }

    console.log(`ancienne règle  : ${oldTotal} substitutions, dont ${oldInWord} à l'intérieur d'un mot`);
    console.log(`règle actuelle  : ${newTotal} substitutions, dont ${newInWord} à l'intérieur d'un mot`);
    console.log(`entités refusées par la règle actuelle (trop ambiguës) : ${skipped}\n`);

    worst.sort((a, b) => b.inWord - a.inWord);
    console.log('pires entités sous l\'ancienne règle :');
    for (const w of worst.slice(0, 8)) {
        console.log(`  ${JSON.stringify(w.ent).padEnd(28)} ${String(w.inWord).padStart(5)} dans un mot   ex: …${w.sample}…`);
    }

    // Une entité détectée que la substitution ne retrouve jamais reste en clair dans le
    // document remis au tiers : c'est la seule vraie fuite de PII possible ici.
    console.log(`\nentités jamais retrouvées dans le texte (fuite de PII) : ${neverMatched.length}`);
    for (const e of neverMatched.slice(0, 10)) console.log(`   ${JSON.stringify(e)}`);

    console.log(`\nentités refusées comme trop ambiguës (${skipped}) :`);
    console.log('   ' + skippedList.slice(0, 25).map(e => JSON.stringify(e)).join(' '));

    console.log(`\nCRITERE «0 substitution à l'intérieur d'un mot» : ${newInWord === 0 ? 'TENU' : 'ECHOUE'}`);
    if (newInWord !== 0) {
        for (const o of offenders.slice(0, 10)) {
            console.log(`  ${JSON.stringify(o.ent)} → ${o.inWord}`);
            for (const s of o.samples.slice(0, 3)) console.log(`      …${s}…`);
        }
        process.exitCode = 1;
    }
}

main();
