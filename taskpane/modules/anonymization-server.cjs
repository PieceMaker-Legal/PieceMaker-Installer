/**
 * Anonymization Server Module
 *
 * Handles server-side anonymization functionality including:
 * - Mapping storage and retrieval (in-memory Map + disk persistence)
 * - Text anonymization/deanonymization endpoints
 * - File management (mapping_{documentId}.json)
 *
 * This module is meant to be used with server.cjs
 */

const fs = require('fs');
const path = require('path');

// ============================================
// STORAGE
// ============================================

// In-memory storage of anonymization mappings by document
const anonymizationMappings = new Map();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Read file and strip BOM if present
 */
function readFileStripBOM(filePath, encoding) {
    let content = fs.readFileSync(filePath, encoding);
    // Strip BOM if present
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
    }
    return content;
}

/**
 * Escape regex special characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// ENTITY MATCHING
// ============================================

/**
 * Minimum length below which an entity is never substituted unless it is an
 * all-caps acronym (see buildEntityRegex). Measured on GENSIGHT_URD: entities of
 * 2-3 chars such as "CA", "us", "AU", "RU", "ZA" triggered 10 000+ substitutions,
 * of which >99% landed inside unrelated words (capital, business, Faubourg, rue,
 * organization).
 */
const MIN_ENTITY_LENGTH = 4;

/** Word characters, Unicode-aware — JS \b is ASCII-only and breaks on "Motté". */
const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

/**
 * Punctuation that exists in several Unicode spellings, mapped to a class matching all of
 * them. Same reasoning as the whitespace tolerance below, and not hypothetical: the
 * scanner normalises entity text with NFKC, which rewrites U+2011 NON-BREAKING HYPHEN to
 * U+2010 HYPHEN. GENSIGHT contains "Kreos‑A" with U+2011, so the mapping carried
 * "Kreos‐A" with U+2010 and the substitution never found it — an entity detected and left
 * in clear in the delivered document. Verified by verify_substitution.cjs, which counts
 * entities whose regex matches nothing.
 */
const CHAR_VARIANTS = [
    // hyphen-minus, hyphen, non-breaking hyphen, figure/en/em dash, minus sign
    { chars: '-‐‑‒–—―−', class: '[-\\u2010-\\u2015\\u2212]' },
    // straight and typographic apostrophes — ubiquitous in French ("d'affaires")
    { chars: "'‘’ʼ´", class: "['\\u2018\\u2019\\u02BC\\u00B4]" },
    // straight and typographic double quotes
    { chars: '"“”«»', class: '["\\u201C\\u201D]' },
];

const VARIANT_OF = new Map();
for (const { chars, class: cls } of CHAR_VARIANTS) {
    for (const c of chars) VARIANT_OF.set(c, cls);
}

/** Escape a token, replacing each variant-bearing character by its class. */
function escapeWithVariants(token) {
    let out = '';
    for (const ch of token) {
        out += VARIANT_OF.get(ch) || escapeRegex(ch);
    }
    return out;
}

/**
 * Build the regex used to find an entity in the document text.
 *
 * Three properties the previous `new RegExp(escapeRegex(x), 'gi')` did not have:
 *
 *  1. Word boundaries. Without them a 2-letter entity rewrites a seventh of the
 *     document from inside other words.
 *  2. Whitespace tolerance. Entities extracted from converted Markdown carry hard
 *     line breaks, double spaces and NBSP ("Board\nof  Directors"). Escaping them
 *     literally means the entity matches only where that exact run of whitespace
 *     occurs — i.e. almost nowhere, so the PII was never substituted at all.
 *     Collapsing every whitespace run to \s+ makes one entity match all its
 *     written forms.
 *  3. Case sensitivity for short acronyms. "EDF"/"SNCF"/"BNP" must still match, but
 *     case-insensitively "US" also matches the pronoun "us". Entities shorter than
 *     MIN_ENTITY_LENGTH are therefore matched case-sensitively and only if they are
 *     all-caps; longer entities stay case-insensitive.
 *
 * @returns {RegExp|null} null when the entity is too ambiguous to substitute safely.
 */
function buildEntityRegex(entity) {
    if (typeof entity !== 'string') return null;

    const trimmed = entity.trim();
    if (!trimmed) return null;

    // Must contain at least one letter or digit — pure punctuation is never an entity.
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;

    const isShort = trimmed.length < MIN_ENTITY_LENGTH;
    const isAcronym = /^[\p{Lu}\p{N}][\p{Lu}\p{N}.&-]*$/u.test(trimmed);

    // Short and not an acronym → too ambiguous, skip entirely.
    if (isShort && (!isAcronym || trimmed.length < 2)) return null;

    // Any run of whitespace in the entity matches any run of whitespace in the text, and
    // each hyphen/apostrophe/quote matches all of its Unicode spellings.
    const pattern = trimmed
        .split(/\s+/)
        .map(escapeWithVariants)
        .join('\\s+');

    const flags = isShort ? 'gu' : 'giu';
    return new RegExp(WORD_BOUNDARY_BEFORE + pattern + WORD_BOUNDARY_AFTER, flags);
}

/**
 * Order mapping entries longest-entity-first.
 *
 * Substitution is sequential, so a nested entity must never run before the entity
 * that contains it: replacing LOCATION "French" before ORGANIZATION "French
 * Monetary and Financial Code" turns the latter into "ADRESSE_07 Monetary and
 * Financial Code". Longest-first means the containing entity is consumed first and
 * the inner one can no longer match it.
 */
function byDescendingEntityLength(getEntity) {
    return (a, b) => {
        const la = (getEntity(a) || '').length;
        const lb = (getEntity(b) || '').length;
        return lb - la;
    };
}

/**
 * Create SIREN regex (ignores spaces)
 */
function createSirenRegex(siren) {
    if (!siren) return null;
    const digits = siren.replace(/\s+/g, '');
    if (!/^\d{9}$/.test(digits)) return null;

    const pattern = digits.split('').map((d, i) => {
        if (i > 0 && i % 3 === 0) {
            return `\\s*${d}`;
        }
        return d;
    }).join('');

    return new RegExp(pattern, 'g');
}

// ============================================
// ROUTE FACTORY
// ============================================

/**
 * Create anonymization routes
 *
 * @param {Function} getOutputPath - Function to get the output directory path
 * @returns {Object} Express router with all anonymization routes
 */
function createAnonymizationRoutes(getOutputPath) {
    const express = require('express');
    const router = express.Router();

    // ========================================
    // GET /api/anonymize/mapping/:documentId
    // ========================================
    router.get('/mapping/:documentId', (req, res) => {
        try {
            const { documentId } = req.params;

            const mappingData = anonymizationMappings.get(documentId);
            if (!mappingData) {
                return res.status(404).json({ error: 'Aucun mapping trouvé' });
            }

            res.json(mappingData);

        } catch (error) {
            console.error('Erreur /api/anonymize/mapping:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================
    // PUT /api/anonymize/mapping/:documentId
    // ========================================
    router.put('/mapping/:documentId', (req, res) => {
        try {
            const { documentId } = req.params;
            const { mapping, reverse_mapping, extracted_data } = req.body;

            if (!mapping || !reverse_mapping) {
                return res.status(400).json({ error: 'Mapping et reverse_mapping requis' });
            }

            console.log(`📝 Mise à jour du mapping pour: ${documentId}`);

            // Update in-memory
            anonymizationMappings.set(documentId, {
                mapping,
                reverse_mapping,
                extracted_data: extracted_data || {},
                timestamp: new Date().toISOString()
            });

            // Save to disk
            const outputDir = getOutputPath();
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);
            fs.writeFileSync(
                mappingPath,
                JSON.stringify({ mapping, reverse_mapping, extracted_data }, null, 2),
                'utf8'
            );

            console.log(`✅ Mapping sauvegardé: ${mappingPath}`);

            res.json({ success: true, message: 'Mapping mis à jour' });

        } catch (error) {
            console.error('Erreur /api/anonymize/mapping PUT:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================
    // DELETE /api/anonymize/mapping/:documentId
    // ========================================
    router.delete('/mapping/:documentId', (req, res) => {
        try {
            const { documentId } = req.params;

            if (anonymizationMappings.has(documentId)) {
                anonymizationMappings.delete(documentId);
                return res.json({ success: true });
            }

            res.status(404).json({ error: 'Mapping non trouvé' });

        } catch (error) {
            console.error('Erreur /api/anonymize/mapping DELETE:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================
    // GET /api/anonymize/files/:documentId
    // ========================================
    router.get('/files/:documentId', (req, res) => {
        try {
            const { documentId } = req.params;
            const outputDir = getOutputPath();

            const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
            const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

            // Check if files exist
            const compilationExists = fs.existsSync(compilationPath);
            const mappingExists = fs.existsSync(mappingPath);

            if (!compilationExists && !mappingExists) {
                return res.status(404).json({ error: 'Aucun fichier trouvé pour ce document' });
            }

            const result = {
                found: true
            };

            if (compilationExists) {
                const compilationFile = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));

                // Support for old format (array) and new format (object with informations_dossier)
                if (Array.isArray(compilationFile)) {
                    // Old format - direct array
                    result.compilation_documents = compilationFile;
                    result.informations_dossier = {};
                } else {
                    // New format - object with documents and informations_dossier
                    result.compilation_documents = compilationFile.documents || [];
                    result.informations_dossier = compilationFile.informations_dossier || {};
                }
            }

            if (mappingExists) {
                const mappingData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));
                result.mapping = mappingData.mapping;
                result.reverse_mapping = mappingData.reverse_mapping;

                // Store mapping in Map for later calls
                anonymizationMappings.set(documentId, {
                    mapping: mappingData.mapping,
                    reverse_mapping: mappingData.reverse_mapping,
                    extracted_data: mappingData.extracted_data || {},
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Mapping chargé depuis le disque et stocké en mémoire pour: ${documentId}`);
            }

            res.json(result);

        } catch (error) {
            console.error('Erreur /api/anonymize/files:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================
    // DELETE /api/anonymize/files/:documentId
    // ========================================
    router.delete('/files/:documentId', (req, res) => {
        try {
            const { documentId } = req.params;
            const outputDir = getOutputPath();

            const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
            const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

            let deleted = false;

            // Delete compilation file
            if (fs.existsSync(compilationPath)) {
                fs.unlinkSync(compilationPath);
                console.log(`🗑️ Fichier supprimé: ${compilationPath}`);
                deleted = true;
            }

            // Delete mapping file
            if (fs.existsSync(mappingPath)) {
                fs.unlinkSync(mappingPath);
                console.log(`🗑️ Fichier supprimé: ${mappingPath}`);
                deleted = true;
            }

            // Delete from in-memory Map
            if (anonymizationMappings.has(documentId)) {
                anonymizationMappings.delete(documentId);
                deleted = true;
            }

            if (deleted) {
                return res.json({ success: true, message: 'Fichiers supprimés' });
            }

            res.status(404).json({ error: 'Aucun fichier trouvé pour ce document' });

        } catch (error) {
            console.error('Erreur /api/anonymize/files DELETE:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================
    // POST /api/anonymize/text
    // ========================================
    router.post('/text', (req, res) => {
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📥 REQUÊTE /api/anonymize/text reçue');
            console.log('Body reçu:', JSON.stringify(req.body, null, 2));

            const { text, documentId, direction } = req.body;

            // Load mapping from memory OR from disk
            let mappingData = anonymizationMappings.get(documentId);

            if (!mappingData) {
                console.log(`📂 Mapping absent en mémoire, chargement depuis le disque...`);

                const outputDir = getOutputPath();
                const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

                if (!fs.existsSync(mappingPath)) {
                    console.error('❌ Fichier mapping introuvable:', mappingPath);
                    return res.status(404).json({
                        error: 'Mapping non trouvé pour ce document',
                        text: text
                    });
                }

                const fileData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));

                // Store in memory for next calls
                mappingData = {
                    mapping: fileData.mapping,
                    reverse_mapping: fileData.reverse_mapping,
                    extracted_data: fileData.extracted_data || {},
                    timestamp: new Date().toISOString()
                };

                anonymizationMappings.set(documentId, mappingData);
                console.log('✅ Mapping chargé depuis le disque et mis en cache');
            }

            console.log('🗂️ Catégories disponibles:', Object.keys(mappingData.mapping));
            console.log('🔄 Reverse mapping entries:', Object.keys(mappingData.reverse_mapping).length);

            let result = text;
            let replacements = 0;

            if (direction === 'anonymize') {
                console.log('🔒 Mode ANONYMISATION');

                const firstKey = Object.keys(mappingData.mapping)[0];
                const isHierarchical = firstKey &&
                                      ['personnes_physiques', 'societes', 'adresses', 'siren'].includes(firstKey);

                console.log('🔍 Format détecté:', isHierarchical ? 'HIÉRARCHIQUE' : 'PLAT');

                if (isHierarchical) {
                    // Flatten across categories before ordering: nesting is frequently
                    // cross-category (LOCATION "French" inside ORGANIZATION "French
                    // Monetary and Financial Code"), so sorting inside each category
                    // separately would not prevent it.
                    const entries = [];
                    for (const category of ['personnes_physiques', 'societes', 'adresses', 'siren']) {
                        if (mappingData.mapping[category]) {
                            for (const [entity, data] of Object.entries(mappingData.mapping[category])) {
                                entries.push({ category, entity, data });
                            }
                        }
                    }
                    entries.sort(byDescendingEntityLength(
                        (e) => e.data.original || e.data.variant || e.entity
                    ));

                    for (const { category, data } of entries) {
                        const code = data.code;
                        const original = data.original;
                        const variant = data.variant;

                        // Special treatment for SIREN: ignore spaces
                        if (category === 'siren') {
                            if (original) {
                                const sirenRegex = createSirenRegex(original);
                                if (sirenRegex) {
                                    const before = result;
                                    result = result.replace(sirenRegex, code);
                                    if (before !== result) replacements++;
                                }
                            }

                            if (variant && variant !== original) {
                                const sirenRegex = createSirenRegex(variant);
                                if (sirenRegex) {
                                    const before = result;
                                    result = result.replace(sirenRegex, code);
                                    if (before !== result) replacements++;
                                }
                            }
                        } else if (category === 'adresses') {
                            // Special treatment for addresses: check for parsed data
                            const addressData = mappingData.extracted_data?.adresses?.[code];
                            const parsed = addressData?.parsed;

                            if (parsed?.anonymization_strategy === 'partial' && parsed.street_part) {
                                // PARTIAL: Only anonymize street part, preserve city/postal/country
                                const streetPart = parsed.street_part;
                                const preservedParts = [
                                    parsed.postal_code,
                                    parsed.city,
                                    parsed.country
                                ].filter(x => x).join(' ');

                                // Replace street part with code, append preserved parts
                                // "123 Rue de Rivoli, 75001 Paris, France" → "ADRESSE_01, 75001 Paris, France"
                                const streetRegex = buildEntityRegex(streetPart);
                                if (streetRegex) {
                                    const before = result;
                                    result = result.replace(streetRegex, () => {
                                        return preservedParts ? `${code}, ${preservedParts}` : code;
                                    });
                                    if (before !== result) replacements++;
                                }
                            } else if (parsed?.anonymization_strategy === 'full') {
                                // FULL: Anonymize entire address (parse failure fallback)
                                for (const candidate of [original, variant]) {
                                    if (!candidate) continue;
                                    if (candidate === variant && variant === original) continue;
                                    const regex = buildEntityRegex(candidate);
                                    if (!regex) continue;
                                    const before = result;
                                    result = result.replace(regex, code);
                                    if (before !== result) replacements++;
                                }
                            }
                            // else if anonymization_strategy === 'none': city-only, no replacement
                        } else {
                            // Normal treatment for other categories
                            for (const candidate of [original, variant]) {
                                if (!candidate) continue;
                                if (candidate === variant && variant === original) continue;
                                const regex = buildEntityRegex(candidate);
                                if (!regex) continue;
                                const before = result;
                                result = result.replace(regex, code);
                                if (before !== result) replacements++;
                            }
                        }
                    }
                } else {
                    // Flat mapping format — longest entity first, so a nested entity
                    // never consumes the one containing it (see byDescendingEntityLength).
                    const flatEntries = Object.entries(mappingData.mapping)
                        .sort(byDescendingEntityLength(([entity]) => entity));

                    for (const [original, code] of flatEntries) {
                        if (!original) continue;

                        // Check if this is an address code with parsed data
                        if (code.startsWith('ADRESSE_')) {
                            const addressData = mappingData.extracted_data?.adresses?.[code];
                            const parsed = addressData?.parsed;

                            if (parsed?.anonymization_strategy === 'partial' && parsed.street_part) {
                                // PARTIAL: Only anonymize street part, preserve city/postal/country
                                const streetPart = parsed.street_part;
                                const preservedParts = [
                                    parsed.postal_code,
                                    parsed.city,
                                    parsed.country
                                ].filter(x => x).join(' ');

                                // Replace street part with code, append preserved parts
                                const streetRegex = buildEntityRegex(streetPart);
                                if (streetRegex) {
                                    const before = result;
                                    result = result.replace(streetRegex, () => {
                                        return preservedParts ? `${code}, ${preservedParts}` : code;
                                    });
                                    if (before !== result) replacements++;
                                }
                                continue; // Skip normal replacement
                            } else if (parsed?.anonymization_strategy === 'none') {
                                // City-only: skip replacement
                                continue;
                            }
                            // else: full anonymization (fallthrough to normal replacement)
                        }

                        // Normal replacement for non-addresses or full address anonymization
                        const regex = buildEntityRegex(original);
                        if (!regex) continue;
                        const before = result;
                        result = result.replace(regex, code);
                        if (before !== result) replacements++;
                    }
                }

            } else if (direction === 'deanonymize') {
                console.log('🔓 Mode DÉSANONYMISATION');
                console.log(`📄 Reverse mapping: ${Object.keys(mappingData.reverse_mapping).length} entrées`);
                console.log('🔑 Clés du reverse_mapping:', Object.keys(mappingData.reverse_mapping));
                console.log('📝 Extrait du texte à dé-anonymiser:', result.substring(0, 200));

                for (const [code, original] of Object.entries(mappingData.reverse_mapping)) {
                    if (!code || !original) continue;

                    console.log(`   🔍 Recherche de "${code}" pour remplacer par "${original}"`);
                    const regex = new RegExp(escapeRegex(code), 'g');
                    const matches = result.match(regex);
                    console.log(`      Occurrences trouvées: ${matches ? matches.length : 0}`);

                    // Check if this is an address with partial anonymization
                    if (code.startsWith('ADRESSE_')) {
                        const addressData = mappingData.extracted_data?.adresses?.[code];
                        const parsed = addressData?.parsed;

                        if (parsed?.anonymization_strategy === 'partial') {
                            // Reconstruct full address from code + preserved parts
                            // "ADRESSE_01, 75001 Paris, France" → "123 Rue de Rivoli, 75001 Paris, France"
                            const fullAddress = [
                                parsed.street_part,
                                parsed.postal_code,
                                parsed.city,
                                parsed.country
                            ].filter(x => x).join(', ');

                            // Match pattern: CODE, preserved_parts OR just CODE
                            const addressRegex = new RegExp(
                                `${escapeRegex(code)}(?:,\\s*[^${escapeRegex(code).charAt(0)}]+)?`,
                                'g'
                            );

                            const before = result;
                            result = result.replace(addressRegex, fullAddress);
                            if (before !== result) {
                                console.log(`      ✅ Adresse reconstruite: ${fullAddress}`);
                                replacements++;
                            }
                            continue;
                        }
                        // else: fall through to normal de-anonymization for full/none strategies
                    }

                    // Normal de-anonymization for non-addresses or full address anonymization
                    const before = result;
                    // Handle array format in reverse_mapping
                    const originalValue = Array.isArray(original) ? original[0] : original;
                    result = result.replace(regex, originalValue);
                    if (before !== result) {
                        console.log(`      ✅ Remplacement effectué !`);
                        replacements++;
                    } else {
                        console.log(`      ❌ Aucun remplacement`);
                    }
                }
            }

            console.log('\n📊 RÉSUMÉ:');
            console.log(`   Remplacements: ${replacements}`);
            console.log(`   Texte modifié: ${text !== result ? 'OUI' : 'NON'}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            res.json({ text: result, replacements });

        } catch (error) {
            console.error('💥 ERREUR /api/anonymize/text:', error);
            console.error('Stack:', error.stack);
            res.status(500).json({ error: error.message, text: req.body?.text || '' });
        }
    });

    return router;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    createAnonymizationRoutes,
    anonymizationMappings,
    // Exported so the substitution rules can be checked against a real document rather
    // than reasoned about — see websocket-server/scripts/presidio-gliner/eval/
    // verify_substitution.cjs, which asserts the acceptance criterion "zero substitution
    // inside a word" on GENSIGHT_URD.
    buildEntityRegex,
    byDescendingEntityLength
};
