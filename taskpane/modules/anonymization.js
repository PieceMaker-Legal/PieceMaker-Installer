/**
 * Anonymization Module
 *
 * Handles all anonymization-related functionality including:
 * - Mapping management (validation, merging, conversion)
 * - Dossier info management (parties clientes/adverses)
 * - Tampon configuration
 * - Text anonymization/deanonymization
 *
 * CRITICAL: This module maintains 100% backward compatibility with existing code.
 * The anonymizeText() function MUST work exactly as before.
 */

// ============================================
// STATE
// ============================================

const anonymization = {
    documentId: null,
    mapping: null,
    reverse_mapping: null,
    files: [],
    compilationFile: null,
    enabled: false,
    tamponImage: null,
    dossierInfo: null,
    pendingMapping: null,
    selectedFiles: []
};

// Counters for partie items
let partieClienteCounter = 1;
let partieAdverseCounter = 1;

// ============================================
// CORE ANONYMIZATION FUNCTIONS (CRITICAL)
// ============================================

/**
 * Anonymize or deanonymize text using the current mapping
 *
 * CRITICAL FUNCTION: This is used throughout the application.
 * ANY CHANGES must maintain 100% backward compatibility.
 *
 * @param {string} text - Text to process
 * @param {string} direction - 'anonymize' or 'deanonymize'
 * @returns {Promise<string>} Processed text
 */
async function anonymizeText(text, direction = 'anonymize') {
    console.log(`[anonymizeText] 🔍 Direction: ${direction}`);
    console.log(`[anonymizeText] 📋 Enabled: ${anonymization.enabled}, DocId: ${anonymization.documentId}`);
    console.log(`[anonymizeText] 📄 Texte (extrait): ${text.substring(0, 100)}...`);

    if (!anonymization.enabled || !anonymization.documentId) {
        console.log('[anonymizeText] ⚠️ DÉSACTIVÉ - retour du texte original');
        return text;
    }

    try {
        console.log('[anonymizeText] 📤 Envoi requête au serveur...');
        const response = await fetch('https://localhost:43098/api/anonymize/text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                documentId: anonymization.documentId,
                direction: direction
            })
        });

        if (!response.ok) {
            console.error('[anonymizeText] ❌ Erreur HTTP:', response.status);
            return text;
        }

        const result = await response.json();
        console.log(`[anonymizeText] ✅ Réponse reçue, ${result.replacements || 0} remplacements`);
        console.log(`[anonymizeText] 📄 Résultat (extrait): ${result.text.substring(0, 100)}...`);
        return result.text;

    } catch (error) {
        console.error('[anonymizeText] ❌ Erreur:', error);
        return text;
    }
}

// ============================================
// MAPPING MANAGEMENT
// ============================================

/**
 * Merge mapping with dossier info to create smart codes
 * (CLIENT_1_PERS_PHYSIQUE instead of PERSONNE_PHYSIQUE_01)
 */
function mergeMappingWithDossierInfo(mapping, reverse_mapping, dossierInfo) {
    if (!dossierInfo || (!dossierInfo.parties_clientes && !dossierInfo.parties_adverses)) {
        console.log('[mergeMappingWithDossierInfo] Pas d\'informations dossier, retour mapping original');
        return { mapping, reverse_mapping };
    }

    console.log('[mergeMappingWithDossierInfo] Début fusion avec informations dossier');

    const newMapping = { ...mapping };
    const newReverseMapping = { ...reverse_mapping };

    // Helper function to normalize strings
    const normalize = (str) => {
        return str
            .toUpperCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    // Function to find and replace in existing mapping
    const findAndReplace = (searchTerms, newCode, principalValue) => {
        const foundKeys = [];

        searchTerms.forEach(term => {
            const normalizedTerm = normalize(term);

            // Search in existing mapping
            for (const [key, value] of Object.entries(newMapping)) {
                const normalizedKey = normalize(key);

                // Exact or partial match
                if (normalizedKey === normalizedTerm ||
                    normalizedKey.includes(normalizedTerm) ||
                    normalizedTerm.includes(normalizedKey)) {

                    // Remove old code from reverse mapping
                    delete newReverseMapping[value];

                    // Replace with new code
                    newMapping[key] = newCode;
                    foundKeys.push(key);
                }
            }

            // Add the term itself to mapping
            if (!foundKeys.includes(term)) {
                newMapping[term] = newCode;
                foundKeys.push(term);
            }
        });

        // Update reverse mapping with principal value (as array for consistency)
        newReverseMapping[newCode] = [principalValue];

        return foundKeys;
    };

    // 1. Process parties clientes
    if (dossierInfo.parties_clientes) {
        dossierInfo.parties_clientes.forEach((partie, index) => {
            const clientNumber = index + 1;

            if (partie.type === 'personne_physique') {
                const code = `CLIENT_${clientNumber}_PERS_PHYSIQUE`;
                const nom = partie.nom;

                const searchTerms = [nom];
                // Add name parts (first name, last name)
                const parts = nom.split(' ').filter(p => p.length > 2);
                searchTerms.push(...parts);

                const found = findAndReplace(searchTerms, code, nom);
                console.log(`[CLIENT ${clientNumber} PP] ${nom} → ${code} (${found.length} variants trouvés)`);

            } else if (partie.type === 'societe') {
                const formeSociale = partie.forme_sociale || 'SOCIETE';
                const code = `CLIENT_${clientNumber}_${formeSociale}`;
                const societeNom = partie.societe_nom;
                const representant = partie.representant;

                const searchTerms = [
                    societeNom,
                    `${societeNom} ${formeSociale}`,
                    formeSociale
                ];

                const found = findAndReplace(searchTerms, code, `${societeNom} ${formeSociale}`);
                console.log(`[CLIENT ${clientNumber} ${formeSociale}] ${societeNom} → ${code} (${found.length} variants trouvés)`);

                // Représentant
                if (representant) {
                    const codeDirigeant = `DIRIGEANT_CLIENT_${clientNumber}`;
                    const searchTermsDirigeant = [representant];
                    const parts = representant.split(' ').filter(p => p.length > 2);
                    searchTermsDirigeant.push(...parts);

                    const foundDirigeant = findAndReplace(searchTermsDirigeant, codeDirigeant, representant);
                    console.log(`[DIRIGEANT CLIENT ${clientNumber}] ${representant} → ${codeDirigeant} (${foundDirigeant.length} variants trouvés)`);
                }
            }
        });
    }

    // 2. Process parties adverses
    if (dossierInfo.parties_adverses) {
        dossierInfo.parties_adverses.forEach((partie, index) => {
            const adverseNumber = index + 1;

            if (partie.type === 'personne_physique') {
                const code = `ADVERSAIRE_${adverseNumber}_PERS_PHYSIQUE`;
                const nom = partie.nom;

                const searchTerms = [nom];
                const parts = nom.split(' ').filter(p => p.length > 2);
                searchTerms.push(...parts);

                const found = findAndReplace(searchTerms, code, nom);
                console.log(`[ADVERSAIRE ${adverseNumber} PP] ${nom} → ${code} (${found.length} variants trouvés)`);

            } else if (partie.type === 'societe') {
                const formeSociale = partie.forme_sociale || 'SOCIETE';
                const code = `ADVERSAIRE_${adverseNumber}_${formeSociale}`;
                const societeNom = partie.societe_nom;
                const representant = partie.representant;

                const searchTerms = [
                    societeNom,
                    `${societeNom} ${formeSociale}`,
                    formeSociale
                ];

                const found = findAndReplace(searchTerms, code, `${societeNom} ${formeSociale}`);
                console.log(`[ADVERSAIRE ${adverseNumber} ${formeSociale}] ${societeNom} → ${code} (${found.length} variants trouvés)`);

                // Représentant
                if (representant) {
                    const codeDirigeant = `DIRIGEANT_ADVERSAIRE_${adverseNumber}`;
                    const searchTermsDirigeant = [representant];
                    const parts = representant.split(' ').filter(p => p.length > 2);
                    searchTermsDirigeant.push(...parts);

                    const foundDirigeant = findAndReplace(searchTermsDirigeant, codeDirigeant, representant);
                    console.log(`[DIRIGEANT ADVERSAIRE ${adverseNumber}] ${representant} → ${codeDirigeant} (${foundDirigeant.length} variants trouvés)`);
                }
            }
        });
    }

    console.log('[mergeMappingWithDossierInfo] Fusion terminée');
    console.log('  → Mapping original:', Object.keys(mapping).length, 'entrées');
    console.log('  → Mapping fusionné:', Object.keys(newMapping).length, 'entrées');
    console.log('  → Reverse mapping fusionné:', Object.keys(newReverseMapping).length, 'entrées');
    console.log('  → Reverse mapping fusionné (détails):', newReverseMapping);

    return { mapping: newMapping, reverse_mapping: newReverseMapping };
}

/**
 * Convert flat mapping to hierarchical structure for display
 */
function convertFlatToHierarchical(flatMapping, flatReverse) {
    const hierarchical = {
        personnes_physiques: {},
        societes: {},
        adresses: {},
        siren: {}
    };

    // Group by code
    const codeToVariants = {};
    for (const [original, code] of Object.entries(flatMapping)) {
        if (!codeToVariants[code]) {
            codeToVariants[code] = [];
        }
        codeToVariants[code].push(original);
    }

    console.log('[convertFlatToHierarchical] Codes groupés:', codeToVariants);

    // Create hierarchical structure
    for (const [code, variants] of Object.entries(codeToVariants)) {
        let category;
        if (code.startsWith('SIREN_')) category = 'siren';
        else if (code.startsWith('ADRESSE_')) category = 'adresses';
        else if (code.startsWith('PERSONNE_MORALE_')) category = 'societes';
        else if (code.startsWith('PERSONNE_')) category = 'personnes_physiques';
        else if (code.startsWith('SOCIETE_')) category = 'societes';
        // Support dossier codes (CLIENT, ADVERSAIRE, DIRIGEANT)
        else if (code.startsWith('CLIENT_') && (code.includes('SOCIÉTÉ') || code.includes('SA') || code.includes('SARL'))) category = 'societes';
        else if (code.startsWith('CLIENT_') && code.includes('PERS_PHYSIQUE')) category = 'personnes_physiques';
        else if (code.startsWith('ADVERSAIRE_') && (code.includes('SOCIÉTÉ') || code.includes('SA') || code.includes('SARL'))) category = 'societes';
        else if (code.startsWith('ADVERSAIRE_') && code.includes('PERS_PHYSIQUE')) category = 'personnes_physiques';
        else if (code.startsWith('DIRIGEANT_CLIENT_') || code.startsWith('DIRIGEANT_ADVERSAIRE_')) category = 'personnes_physiques';
        // Support short OLLAMA codes (P01, S01, etc.)
        else if (code.match(/^P\d+$/)) category = 'personnes_physiques';
        else if (code.match(/^S\d+$/)) category = 'societes';
        else if (code.match(/^SA_\d+$/)) category = 'societes';
        else continue;

        // Choose main variant from reverse_mapping
        let mainVariant = flatReverse[code];

        // If reverse_mapping contains an array, take first element
        if (Array.isArray(mainVariant)) {
            mainVariant = mainVariant[0];
        }

        // If main variant doesn't exist in detected variants, fallback
        if (!mainVariant || !variants.includes(mainVariant)) {
            mainVariant = variants.find(v => v[0] === v[0].toUpperCase() && v === v.toUpperCase()) ||
                         variants.find(v => v[0] === v[0].toUpperCase()) ||
                         variants[0];
        }

        // Reorganize variants so main variant is first
        const sortedVariants = [mainVariant, ...variants.filter(v => v !== mainVariant)];

        hierarchical[category][mainVariant] = {
            original: mainVariant,
            code: code,
            variants: [...new Set(sortedVariants)]  // Deduplicate while preserving order
        };
    }

    console.log('[convertFlatToHierarchical] Hiérarchique créé:', hierarchical);
    return hierarchical;
}

/**
 * Show mapping validation modal with editing capabilities
 */
function showMappingValidation(result) {
    console.log('[showMappingValidation] Result reçu:', result);

    // Convert flat mapping to hierarchical structure for display
    const hierarchical = convertFlatToHierarchical(result.mapping, result.reverse_mapping);

    // Store both flat (for saving) and hierarchical (for display) versions
    anonymization.pendingMapping = {
        mapping: result.mapping,  // Original flat version
        reverse_mapping: result.reverse_mapping,
        extracted_data: result.extracted_data,
        compilation_documents: result.compilation_documents || [],
        hierarchical: hierarchical  // Hierarchical version for display
    };

    const modal = document.getElementById('mappingModal');
    const content = document.getElementById('mappingContent');

    let html = '<div style="font-size: 12px;">';
    let hasContent = false;

    // Personnes physiques
    if (hierarchical.personnes_physiques && Object.keys(hierarchical.personnes_physiques).length > 0) {
        hasContent = true;
        html += '<h3>👤 Personnes physiques</h3>';
        for (const [entity, data] of Object.entries(hierarchical.personnes_physiques)) {
            html += `<div class="mapping-item" data-category="personnes_physiques" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('personnes_physiques', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('personnes_physiques', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('personnes_physiques', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('personnes_physiques')">➕ Ajouter une personne</button>`;
    }

    // Sociétés
    if (hierarchical.societes && Object.keys(hierarchical.societes).length > 0) {
        hasContent = true;
        html += '<h3>🏢 Sociétés</h3>';
        for (const [entity, data] of Object.entries(hierarchical.societes)) {
            html += `<div class="mapping-item" data-category="societes" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('societes', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('societes', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('societes', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('societes')">➕ Ajouter une société</button>`;
    }

    // Adresses
    if (hierarchical.adresses && Object.keys(hierarchical.adresses).length > 0) {
        hasContent = true;
        html += '<h3>📍 Adresses</h3>';
        for (const [entity, data] of Object.entries(hierarchical.adresses)) {
            html += `<div class="mapping-item" data-category="adresses" data-entity="${entity}">
                <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                ←
                <input type="text" class="mapping-original" value="${data.original}">
                <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('adresses', '${entity}')">🗑️</button>
            </div>`;
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('adresses')">➕ Ajouter une adresse</button>`;
    }

    // SIREN
    if (hierarchical.siren && Object.keys(hierarchical.siren).length > 0) {
        hasContent = true;
        html += '<h3>🔢 Numéros SIREN</h3>';
        for (const [entity, data] of Object.entries(hierarchical.siren)) {
            html += `<div class="mapping-item" data-category="siren" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('siren', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('siren', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('siren', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('siren')">➕ Ajouter un SIREN</button>`;
    }

    html += '</div>';

    if (!hasContent) {
        html = '<div style="padding: 20px; text-align: center; color: #ff6b6b;">⚠️ Aucune entité détectée</div>';
    }

    content.innerHTML = html;
    modal.style.display = 'flex';
}

/**
 * Refresh mapping modal display from modified hierarchical structure
 */
function refreshMappingModal() {
    if (!anonymization.pendingMapping || !anonymization.pendingMapping.hierarchical) {
        console.error('[refreshMappingModal] Pas de pendingMapping ou hierarchical');
        return;
    }

    const modal = document.getElementById('mappingModal');
    const content = document.getElementById('mappingContent');
    const hierarchical = anonymization.pendingMapping.hierarchical;

    let html = '<div style="font-size: 12px;">';
    let hasContent = false;

    // Personnes physiques
    if (hierarchical.personnes_physiques && Object.keys(hierarchical.personnes_physiques).length > 0) {
        hasContent = true;
        html += '<h3>👤 Personnes physiques</h3>';
        for (const [entity, data] of Object.entries(hierarchical.personnes_physiques)) {
            html += `<div class="mapping-item" data-category="personnes_physiques" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('personnes_physiques', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('personnes_physiques', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('personnes_physiques', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('personnes_physiques')">➕ Ajouter une personne</button>`;
    }

    // Sociétés
    if (hierarchical.societes && Object.keys(hierarchical.societes).length > 0) {
        hasContent = true;
        html += '<h3>🏢 Sociétés</h3>';
        for (const [entity, data] of Object.entries(hierarchical.societes)) {
            html += `<div class="mapping-item" data-category="societes" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('societes', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('societes', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('societes', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('societes')">➕ Ajouter une société</button>`;
    }

    // Adresses
    if (hierarchical.adresses && Object.keys(hierarchical.adresses).length > 0) {
        hasContent = true;
        html += '<h3>📍 Adresses</h3>';
        for (const [entity, data] of Object.entries(hierarchical.adresses)) {
            html += `<div class="mapping-item" data-category="adresses" data-entity="${entity}">
                <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                ←
                <input type="text" class="mapping-original" value="${data.original}">
                <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('adresses', '${entity}')">🗑️</button>
            </div>`;
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('adresses')">➕ Ajouter une adresse</button>`;
    }

    // SIREN
    if (hierarchical.siren && Object.keys(hierarchical.siren).length > 0) {
        hasContent = true;
        html += '<h3>🔢 Numéros SIREN</h3>';
        for (const [entity, data] of Object.entries(hierarchical.siren)) {
            html += `<div class="mapping-item" data-category="siren" data-entity="${entity}">
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                        <input type="text" class="mapping-code" value="${data.code}" data-original-code="${data.code}">
                        ←
                        <input type="text" class="mapping-original" value="${data.original}">
                        <button class="delete-mapping-btn" onclick="window.anonymization.deleteMappingItem('siren', '${entity}')">🗑️</button>
                    </div>`;

            if (data.variants && data.variants.length > 1) {
                html += '<div style="margin-left: 20px; margin-top: 8px;">';
                html += '<span style="color: #858585; font-size: 11px;">Variantes détectées:</span>';
                data.variants.forEach((variant, idx) => {
                    html += `
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span style="color: #666; width: 20px; text-align: right; font-size: 10px;">${idx + 1}.</span>
                            <input type="text" class="mapping-variant" value="${variant}" data-variant-index="${idx}" data-original-variant="${variant}">
                            <button class="delete-variant-btn" onclick="window.anonymization.deleteVariant('siren', '${entity}', ${idx})" style="font-size: 12px;">🗑️</button>
                        </div>
                    `;
                });
                html += '</div>';
            }

            html += `
                <div style="margin-left: 20px; margin-top: 4px;">
                    <button class="add-variant-btn" onclick="window.anonymization.addVariant('siren', '${entity}')" style="font-size: 11px; padding: 2px 8px;">+ Ajouter une variante</button>
                </div>
            `;

            html += '</div></div>';
        }
        html += `<button class="add-mapping-btn" onclick="window.anonymization.addMappingItem('siren')">➕ Ajouter un SIREN</button>`;
    }

    html += '</div>';

    if (!hasContent) {
        html = '<div style="padding: 20px; text-align: center; color: #ff6b6b;">⚠️ Aucune entité détectée</div>';
    }

    content.innerHTML = html;
    modal.style.display = 'flex';
}

/**
 * Validate and save mapping
 */
async function validateMapping(addMessageFn, updateFilesDisplayFn) {
    if (!anonymization.pendingMapping) return;

    console.log('[validateMapping] Début de la validation');

    // Reconstruct mapping from DOM
    const flatMapping = {};
    const flatReverse = {};
    document.querySelectorAll('.mapping-item').forEach(item => {
        const category = item.getAttribute('data-category');
        const entity = item.getAttribute('data-entity');
        const codeInput = item.querySelector('.mapping-code');
        const originalInput = item.querySelector('.mapping-original');
        const newCode = codeInput?.value;
        const newOriginal = originalInput?.value;

        // Get all variants
        const variants = [newOriginal];
        item.querySelectorAll('.mapping-variant').forEach(variantInput => {
            variants.push(variantInput.value);
        });

        // Add all variants to flat mapping
        variants.forEach(variant => {
            if (variant && variant.trim()) {
                flatMapping[variant.trim()] = newCode;
            }
        });

        // Reverse mapping (one original per code)
        flatReverse[newCode] = newOriginal;
    });

    console.log('[validateMapping] Mapping plat reconstruit:', flatMapping);

    // Apply validated flat mapping
    anonymization.mapping = flatMapping;
    anonymization.reverse_mapping = flatReverse;
    anonymization.files = anonymization.pendingMapping.compilation_documents || [];
    anonymization.enabled = true;

    // Clean extracted_data to remove excluded elements
    const cleanExtractedData = { ...anonymization.pendingMapping.extracted_data };

    const categories = ['personnes_physiques', 'societes', 'adresses', 'siren'];

    categories.forEach(cat => {
        if (cleanExtractedData[cat]) {
            const cleanCategory = {};
            Object.keys(cleanExtractedData[cat]).forEach(key => {
                const existsAsCode = flatReverse.hasOwnProperty(key);
                const existsAsOriginal = flatMapping.hasOwnProperty(key);

                if (existsAsCode || existsAsOriginal) {
                    cleanCategory[key] = cleanExtractedData[cat][key];
                } else {
                    console.log(`[validateMapping] Suppression de l'élément orphelin dans extracted_data: ${cat}/${key}`);
                }
            });
            cleanExtractedData[cat] = cleanCategory;
        }
    });

    // Save to server
    try {
        console.log('[validateMapping] Sauvegarde du mapping sur le serveur...');

        const response = await fetch(`https://localhost:43098/api/anonymize/mapping/${anonymization.documentId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                mapping: flatMapping,
                reverse_mapping: flatReverse,
                extracted_data: cleanExtractedData
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[validateMapping] Erreur sauvegarde:', response.status, errorText);
            if (addMessageFn) addMessageFn('error', `Erreur lors de la sauvegarde du mapping: ${errorText}`);
        } else {
            console.log('[validateMapping] Mapping sauvegardé avec succès');
            if (addMessageFn) addMessageFn('system', '✅ Mapping sauvegardé sur le serveur');
        }
    } catch (error) {
        console.error('[validateMapping] Erreur sauvegarde mapping:', error);
        if (addMessageFn) addMessageFn('error', `Erreur: ${error.message}`);
    }

    // Close modal
    document.getElementById('mappingModal').style.display = 'none';

    // Update files display
    if (updateFilesDisplayFn) updateFilesDisplayFn();

    if (addMessageFn) {
        const entityCount = Object.keys(anonymization.reverse_mapping || {}).length;
        if (anonymization.files.length > 0) {
            addMessageFn('system', `✅ Anonymisation activée. ${anonymization.files.length} fichier(s) chargé(s), ${entityCount} entité(s) protégée(s).`);
        } else {
            addMessageFn('system', `✅ Anonymisation activée. ${entityCount} entité(s) protégée(s).`);
        }
    }
}

/**
 * Reopen mapping modal
 */
async function reopenMappingModal(getDocumentIdFn, addMessageFn) {
    console.log('[reopenMappingModal] Début de la réouverture du modal');

    // Get documentId
    const documentId = await getDocumentIdFn();
    if (!documentId) {
        console.error('[reopenMappingModal] Impossible de récupérer l\'ID du document');
        if (addMessageFn) addMessageFn('error', 'Impossible de récupérer l\'ID du document');
        return;
    }

    // Load mapping from server
    try {
        console.log('[reopenMappingModal] Chargement du mapping depuis le serveur...');
        const url = `https://localhost:43098/api/anonymize/files/${documentId}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.warn('[reopenMappingModal] Aucun mapping trouvé sur le serveur');
            // Try to rebuild from in-memory mapping
            if (anonymization.mapping && Object.keys(anonymization.mapping).length > 0) {
                console.log('[reopenMappingModal] Utilisation du mapping en mémoire');
                const hierarchical = convertFlatToHierarchical(anonymization.mapping, anonymization.reverse_mapping);
                anonymization.pendingMapping = {
                    mapping: anonymization.mapping,
                    reverse_mapping: anonymization.reverse_mapping,
                    extracted_data: { files: anonymization.files || [] },
                    hierarchical: hierarchical
                };
                refreshMappingModal();
            } else {
                if (addMessageFn) addMessageFn('system', 'Aucun mapping d\'anonymisation disponible. Veuillez d\'abord charger des fichiers pour créer un mapping.');
            }
            return;
        }

        const result = await response.json();
        console.log('[reopenMappingModal] Réponse du serveur:', {
            found: result.found,
            has_mapping: !!result.mapping,
            has_reverse_mapping: !!result.reverse_mapping
        });

        if (result.found && result.mapping && result.reverse_mapping) {
            // Update in-memory mapping from server
            anonymization.mapping = result.mapping;
            anonymization.reverse_mapping = result.reverse_mapping;
            anonymization.files = result.compilation_documents || [];
            anonymization.enabled = true;

            console.log('[reopenMappingModal] Mapping chargé depuis le serveur');

            // Rebuild hierarchical structure for display
            const hierarchical = convertFlatToHierarchical(result.mapping, result.reverse_mapping);
            anonymization.pendingMapping = {
                mapping: result.mapping,
                reverse_mapping: result.reverse_mapping,
                extracted_data: { files: anonymization.files },
                hierarchical: hierarchical
            };

            // Show modal
            refreshMappingModal();
        } else {
            console.warn('[reopenMappingModal] Mapping incomplet dans la réponse du serveur');
            if (addMessageFn) addMessageFn('system', 'Aucun mapping disponible. Veuillez d\'abord charger des fichiers.');
        }
    } catch (error) {
        console.error('[reopenMappingModal] Erreur lors du chargement du mapping:', error);
        if (addMessageFn) addMessageFn('error', `Erreur lors du chargement du mapping: ${error.message}`);
    }
}

// ============================================
// MAPPING EDITING FUNCTIONS
// ============================================

/**
 * Add a variant to an existing mapping entry
 */
function addVariant(category, entity) {
    // Create mini-modal for adding variant
    const addVariantModal = document.createElement('div');
    addVariantModal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
    `;

    addVariantModal.innerHTML = `
        <div style="background: #252526; padding: 20px; border-radius: 8px; min-width: 400px;">
            <h3 style="margin: 0 0 16px 0; color: #cccccc;">➕ Ajouter une variante pour "${entity}"</h3>

            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 4px; color: #cccccc; font-size: 12px;">
                    Nouvelle variante:
                </label>
                <input type="text" id="addVariantInput" placeholder="Ex: ${entity.toLowerCase()}" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #3e3e42; color: #cccccc; border-radius: 4px;">
            </div>

            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button id="cancelAddVariantBtn" style="padding: 8px 16px; background: #3e3e42; border: none; color: #cccccc; border-radius: 4px; cursor: pointer;">
                    Annuler
                </button>
                <button id="confirmAddVariantBtn" style="padding: 8px 16px; background: #0e639c; border: none; color: white; border-radius: 4px; cursor: pointer;">
                    Ajouter
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(addVariantModal);

    // Focus on input
    setTimeout(() => document.getElementById('addVariantInput').focus(), 100);

    // Cancel button
    document.getElementById('cancelAddVariantBtn').onclick = () => {
        addVariantModal.remove();
    };

    // Confirm button
    document.getElementById('confirmAddVariantBtn').onclick = () => {
        const newVariant = document.getElementById('addVariantInput').value.trim();

        if (!newVariant) {
            console.warn('[addVariant] Variante vide, annulation');
            addVariantModal.remove();
            return;
        }

        // Access hierarchical structure
        const hierarchical = anonymization.pendingMapping.hierarchical;
        if (!hierarchical || !hierarchical[category] || !hierarchical[category][entity]) {
            console.error('[addVariant] Structure hiérarchique introuvable:', category, entity);
            addVariantModal.remove();
            return;
        }

        const item = hierarchical[category][entity];
        if (!item.variants) {
            item.variants = [];
        }
        item.variants.push(newVariant);

        console.log('[addVariant] Variante ajoutée:', newVariant, 'pour', entity);

        // Close modal
        addVariantModal.remove();

        // Refresh display
        refreshMappingModal();
    };

    // Close with Escape
    addVariantModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            addVariantModal.remove();
        }
    });

    // Validate with Enter
    document.getElementById('addVariantInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('confirmAddVariantBtn').click();
        }
    });
}

/**
 * Delete a variant from a mapping entry
 */
function deleteVariant(category, entity, variantIndex) {
    // Access hierarchical structure
    const hierarchical = anonymization.pendingMapping.hierarchical;
    if (!hierarchical || !hierarchical[category] || !hierarchical[category][entity]) {
        console.error('[deleteVariant] Structure hiérarchique introuvable:', category, entity);
        return;
    }

    const item = hierarchical[category][entity];
    if (item.variants && Array.isArray(item.variants)) {
        // Don't delete if it's the last variant
        if (item.variants.length <= 1) {
            console.warn('[deleteVariant] Impossible de supprimer la dernière variante');
            return;
        }
        item.variants.splice(variantIndex, 1);
        console.log('[deleteVariant] Variante supprimée:', variantIndex, 'pour', entity);
        // Refresh display
        refreshMappingModal();
    }
}

/**
 * Delete a mapping entry
 */
function deleteMappingItem(category, entity) {
    const item = document.querySelector(`.mapping-item[data-category="${category}"][data-entity="${entity}"]`);
    if (!item) return;

    console.log(`[deleteMappingItem] Suppression de ${category}/${entity}`);

    item.remove();

    // Also delete from pendingMapping
    if (anonymization.pendingMapping?.mapping?.[category]?.[entity]) {
        delete anonymization.pendingMapping.mapping[category][entity];
        console.log(`[deleteMappingItem] Supprimé du mapping: ${category}/${entity}`);
    }

    if (anonymization.pendingMapping?.reverse_mapping?.[category]) {
        // Find and delete in reverse_mapping
        const code = Object.keys(anonymization.pendingMapping.reverse_mapping[category]).find(
            key => anonymization.pendingMapping.reverse_mapping[category][key] === entity
        );
        if (code) {
            delete anonymization.pendingMapping.reverse_mapping[category][code];
            console.log(`[deleteMappingItem] Supprimé du reverse_mapping: ${category}/${code}`);
        }
    }
}

/**
 * Add a new mapping entry
 */
function addMappingItem(category) {
    // Create mini-modal
    const addModal = document.createElement('div');
    addModal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
    `;

    addModal.innerHTML = `
        <div style="background: #252526; padding: 20px; border-radius: 8px; min-width: 400px;">
            <h3 style="margin: 0 0 16px 0; color: #cccccc;">➕ Ajouter une entrée</h3>

            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #cccccc; font-size: 12px;">
                    Texte original à anonymiser:
                </label>
                <input type="text" id="addOriginal" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #3e3e42; color: #cccccc; border-radius: 4px;">
            </div>

            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 4px; color: #cccccc; font-size: 12px;">
                    Code anonymisé (ex: PARTIE_A, SOCIETE_1):
                </label>
                <input type="text" id="addCode" style="width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #3e3e42; color: #cccccc; border-radius: 4px;">
            </div>

            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button id="cancelAddBtn" style="padding: 8px 16px; background: #3e3e42; border: none; color: #cccccc; border-radius: 4px; cursor: pointer;">
                    Annuler
                </button>
                <button id="confirmAddBtn" style="padding: 8px 16px; background: #0e639c; border: none; color: white; border-radius: 4px; cursor: pointer;">
                    Ajouter
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(addModal);

    // Focus on first input
    setTimeout(() => document.getElementById('addOriginal').focus(), 100);

    // Cancel button
    document.getElementById('cancelAddBtn').onclick = () => {
        addModal.remove();
    };

    // Confirm button
    document.getElementById('confirmAddBtn').onclick = () => {
        const original = document.getElementById('addOriginal').value.trim();
        const code = document.getElementById('addCode').value.trim();

        if (!original || !code) {
            alert('Veuillez remplir tous les champs');
            return;
        }

        const entity = original;
        const codeValue = code;

        // Add to pendingMapping
        if (!anonymization.pendingMapping.mapping[category]) {
            anonymization.pendingMapping.mapping[category] = {};
        }
        if (!anonymization.pendingMapping.reverse_mapping[category]) {
            anonymization.pendingMapping.reverse_mapping[category] = {};
        }

        anonymization.pendingMapping.mapping[category][entity] = {
            original: entity,
            code: codeValue,
            variant: entity
        };
        anonymization.pendingMapping.reverse_mapping[category][codeValue] = entity;

        // Close mini-modal
        addModal.remove();

        // Rebuild main modal
        refreshMappingModal();
    };

    // Close with Escape
    addModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            addModal.remove();
        }
    });
}

/**
 * Get category icon
 */
function getCategoryIcon(category) {
    const icons = {
        personnes_physiques: '👤',
        societes: '🏢',
        adresses: '📍',
        siren: '🔢'
    };
    return icons[category] || '';
}

// ============================================
// DOSSIER INFO FUNCTIONS
// ============================================

/**
 * Open dossier info modal
 */
function openDossierInfoModal() {
    const modal = document.getElementById('dossierInfoModal');
    modal.style.display = 'flex';

    // Load existing info if available
    if (anonymization.dossierInfo) {
        loadDossierInfo(anonymization.dossierInfo);
    } else {
        // Initialize with one partie cliente and one partie adverse
        addPartieCliente();
        addPartieAdverse();
    }
}

/**
 * Close dossier info modal
 */
function closeDossierInfoModal() {
    const modal = document.getElementById('dossierInfoModal');
    modal.style.display = 'none';

    // Reset lists
    document.getElementById('partiesClientesList').innerHTML = '';
    document.getElementById('partiesAdversesList').innerHTML = '';
    partieClienteCounter = 1;
    partieAdverseCounter = 1;
}

/**
 * Add partie cliente
 */
function addPartieCliente(data = null) {
    const container = document.getElementById('partiesClientesList');
    const index = partieClienteCounter++;

    const partieDiv = document.createElement('div');
    partieDiv.className = 'partie-item';
    partieDiv.setAttribute('data-index', index);
    partieDiv.style.cssText = 'border: 1px solid #3e3e42; padding: 15px; border-radius: 4px; margin-bottom: 10px; position: relative;';

    partieDiv.innerHTML = `
        <button class="delete-partie-btn" onclick="window.anonymization.deletePartieCliente(${index})" style="position: absolute; top: 10px; right: 10px; background: #d32f2f; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">🗑️</button>

        <div class="form-group" style="margin-bottom: 10px;">
            <label>Type de partie</label>
            <select class="partie-type" data-index="${index}" onchange="window.anonymization.updatePartieClienteFields(${index})">
                <option value="personne_physique" ${data && data.type === 'personne_physique' ? 'selected' : ''}>Personne physique</option>
                <option value="societe" ${data && data.type === 'societe' ? 'selected' : ''}>Société</option>
            </select>
        </div>

        <div class="personne-physique-fields" style="${data && data.type === 'societe' ? 'display: none;' : ''}">
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Nom complet</label>
                <input type="text" class="partie-nom" placeholder="Ex: Jean Dupont" value="${data && data.nom || ''}">
            </div>
        </div>

        <div class="societe-fields" style="${data && data.type === 'personne_physique' ? 'display: none;' : ''}">
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Nom de la société</label>
                <input type="text" class="societe-nom" placeholder="Ex: ABC Entreprise" value="${data && data.societe_nom || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Forme sociale</label>
                <input type="text" class="societe-forme" placeholder="Ex: SAS, SARL, SA..." value="${data && data.forme_sociale || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Représentant légal</label>
                <input type="text" class="societe-representant" placeholder="Ex: Marie Martin" value="${data && data.representant || ''}">
            </div>
        </div>
    `;

    container.appendChild(partieDiv);
}

/**
 * Add partie adverse
 */
function addPartieAdverse(data = null) {
    const container = document.getElementById('partiesAdversesList');
    const index = partieAdverseCounter++;

    const partieDiv = document.createElement('div');
    partieDiv.className = 'partie-item';
    partieDiv.setAttribute('data-index', index);
    partieDiv.style.cssText = 'border: 1px solid #3e3e42; padding: 15px; border-radius: 4px; margin-bottom: 10px; position: relative;';

    partieDiv.innerHTML = `
        <button class="delete-partie-btn" onclick="window.anonymization.deletePartieAdverse(${index})" style="position: absolute; top: 10px; right: 10px; background: #d32f2f; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">🗑️</button>

        <div class="form-group" style="margin-bottom: 10px;">
            <label>Type de partie</label>
            <select class="partie-type" data-index="${index}" onchange="window.anonymization.updatePartieAdverseFields(${index})">
                <option value="personne_physique" ${data && data.type === 'personne_physique' ? 'selected' : ''}>Personne physique</option>
                <option value="societe" ${data && data.type === 'societe' ? 'selected' : ''}>Société</option>
            </select>
        </div>

        <div class="personne-physique-fields" style="${data && data.type === 'societe' ? 'display: none;' : ''}">
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Nom complet</label>
                <input type="text" class="partie-nom" placeholder="Ex: Jean Dupont" value="${data && data.nom || ''}">
            </div>
        </div>

        <div class="societe-fields" style="${data && data.type === 'personne_physique' ? 'display: none;' : ''}">
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Nom de la société</label>
                <input type="text" class="societe-nom" placeholder="Ex: XYZ Corp" value="${data && data.societe_nom || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Forme sociale</label>
                <input type="text" class="societe-forme" placeholder="Ex: SAS, SARL, SA..." value="${data && data.forme_sociale || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Représentant légal</label>
                <input type="text" class="societe-representant" placeholder="Ex: Pierre Durand" value="${data && data.representant || ''}">
            </div>
        </div>
    `;

    container.appendChild(partieDiv);
}

/**
 * Delete partie cliente
 */
function deletePartieCliente(index) {
    const container = document.getElementById('partiesClientesList');
    const partieDiv = container.querySelector(`[data-index="${index}"]`);
    if (partieDiv) {
        partieDiv.remove();
    }
}

/**
 * Delete partie adverse
 */
function deletePartieAdverse(index) {
    const container = document.getElementById('partiesAdversesList');
    const partieDiv = container.querySelector(`[data-index="${index}"]`);
    if (partieDiv) {
        partieDiv.remove();
    }
}

/**
 * Update partie cliente fields based on type selection
 */
function updatePartieClienteFields(index) {
    const container = document.getElementById('partiesClientesList');
    const partieDiv = container.querySelector(`[data-index="${index}"]`);
    if (!partieDiv) return;

    const typeSelect = partieDiv.querySelector('.partie-type');
    const personneFields = partieDiv.querySelector('.personne-physique-fields');
    const societeFields = partieDiv.querySelector('.societe-fields');

    if (typeSelect.value === 'personne_physique') {
        personneFields.style.display = 'block';
        societeFields.style.display = 'none';
    } else {
        personneFields.style.display = 'none';
        societeFields.style.display = 'block';
    }
}

/**
 * Update partie adverse fields based on type selection
 */
function updatePartieAdverseFields(index) {
    const container = document.getElementById('partiesAdversesList');
    const partieDiv = container.querySelector(`[data-index="${index}"]`);
    if (!partieDiv) return;

    const typeSelect = partieDiv.querySelector('.partie-type');
    const personneFields = partieDiv.querySelector('.personne-physique-fields');
    const societeFields = partieDiv.querySelector('.societe-fields');

    if (typeSelect.value === 'personne_physique') {
        personneFields.style.display = 'block';
        societeFields.style.display = 'none';
    } else {
        personneFields.style.display = 'none';
        societeFields.style.display = 'block';
    }
}

/**
 * Collect dossier info from form
 */
function collectDossierInfo() {
    const partiesClientes = [];
    const partiesAdverses = [];

    // Collect parties clientes
    const clientesList = document.getElementById('partiesClientesList');
    const clientesItems = clientesList.querySelectorAll('.partie-item');

    clientesItems.forEach((item, index) => {
        const type = item.querySelector('.partie-type').value;

        if (type === 'personne_physique') {
            const nom = item.querySelector('.partie-nom').value.trim();
            if (nom) {
                partiesClientes.push({
                    type: 'personne_physique',
                    nom: nom.toUpperCase()
                });
            }
        } else {
            const societeNom = item.querySelector('.societe-nom').value.trim();
            const formeSociale = item.querySelector('.societe-forme').value.trim();
            const representant = item.querySelector('.societe-representant').value.trim();

            if (societeNom) {
                partiesClientes.push({
                    type: 'societe',
                    societe_nom: societeNom.toUpperCase(),
                    forme_sociale: formeSociale.toUpperCase(),
                    representant: representant.toUpperCase()
                });
            }
        }
    });

    // Collect parties adverses
    const adversesList = document.getElementById('partiesAdversesList');
    const adversesItems = adversesList.querySelectorAll('.partie-item');

    adversesItems.forEach((item, index) => {
        const type = item.querySelector('.partie-type').value;

        if (type === 'personne_physique') {
            const nom = item.querySelector('.partie-nom').value.trim();
            if (nom) {
                partiesAdverses.push({
                    type: 'personne_physique',
                    nom: nom.toUpperCase()
                });
            }
        } else {
            const societeNom = item.querySelector('.societe-nom').value.trim();
            const formeSociale = item.querySelector('.societe-forme').value.trim();
            const representant = item.querySelector('.societe-representant').value.trim();

            if (societeNom) {
                partiesAdverses.push({
                    type: 'societe',
                    societe_nom: societeNom.toUpperCase(),
                    forme_sociale: formeSociale.toUpperCase(),
                    representant: representant.toUpperCase()
                });
            }
        }
    });

    return {
        parties_clientes: partiesClientes,
        parties_adverses: partiesAdverses
    };
}

/**
 * Load dossier info into form
 */
function loadDossierInfo(info) {
    // Load parties clientes
    if (info.parties_clientes) {
        info.parties_clientes.forEach(partie => {
            addPartieCliente(partie);
        });
    }

    // Load parties adverses
    if (info.parties_adverses) {
        info.parties_adverses.forEach(partie => {
            addPartieAdverse(partie);
        });
    }
}

/**
 * Save dossier info and continue
 */
async function saveDossierInfoAndContinue(addMessageFn, proceedWithFileSelectionFn) {
    const dossierInfo = collectDossierInfo();

    // Verify at least one partie cliente and one partie adverse
    if (dossierInfo.parties_clientes.length === 0) {
        if (addMessageFn) addMessageFn('error', 'Veuillez renseigner au moins une partie cliente.');
        return;
    }

    if (dossierInfo.parties_adverses.length === 0) {
        if (addMessageFn) addMessageFn('error', 'Veuillez renseigner au moins une partie adverse.');
        return;
    }

    // Save info
    anonymization.dossierInfo = dossierInfo;

    // Close modal
    closeDossierInfoModal();

    // Continue with file selection
    if (proceedWithFileSelectionFn) await proceedWithFileSelectionFn();
}

// ============================================
// TAMPON FUNCTIONS
// ============================================

/**
 * Open tampon configuration modal
 */
function openTamponModal() {
    // Show preview if tampon already configured
    if (anonymization.tamponImage) {
        document.getElementById('tamponPreview').style.display = 'block';
        document.getElementById('tamponPreviewImage').src = anonymization.tamponImage;
    } else {
        document.getElementById('tamponPreview').style.display = 'none';
    }

    document.getElementById('modalTampon').classList.add('show');
}

/**
 * Close tampon modal
 */
function closeTamponModal() {
    document.getElementById('modalTampon').classList.remove('show');
}

/**
 * Handle tampon image upload
 */
function handleTamponImageUpload(event, addMessageFn) {
    const file = event.target.files[0];

    if (!file) {
        return;
    }

    // Check file type
    if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
        if (addMessageFn) addMessageFn('system', '❌ Format d\'image non supporté. Utilisez PNG ou JPEG.');
        return;
    }

    // Read file as base64
    const reader = new FileReader();
    reader.onload = function(e) {
        anonymization.tamponImage = e.target.result;

        // Show preview
        document.getElementById('tamponPreview').style.display = 'block';
        document.getElementById('tamponPreviewImage').src = e.target.result;

        console.log('[Tampon] Image chargée:', file.name);
        if (addMessageFn) addMessageFn('system', `✅ Image du tampon chargée : ${file.name}`);
    };

    reader.readAsDataURL(file);
}

/**
 * Save tampon to server
 */
async function saveTampon(addMessageFn) {
    if (!anonymization.tamponImage) {
        if (addMessageFn) addMessageFn('system', '❌ Veuillez d\'abord sélectionner une image.');
        return;
    }

    try {
        // Send tampon to server
        const response = await fetch('https://localhost:43098/api/tampon/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                tamponImage: anonymization.tamponImage
            })
        });

        if (!response.ok) {
            throw new Error('Erreur lors de la sauvegarde sur le serveur');
        }

        const result = await response.json();

        // Store just the filename locally
        localStorage.setItem('piecemaker_tampon_filename', result.filename);

        if (addMessageFn) addMessageFn('system', '✅ Tampon sauvegardé avec succès !');
        closeTamponModal();
    } catch (error) {
        console.error('[Tampon] Erreur sauvegarde:', error);
        if (addMessageFn) addMessageFn('system', '❌ Erreur lors de la sauvegarde du tampon : ' + error.message);
    }
}

/**
 * Clear tampon
 */
async function clearTampon(addMessageFn) {
    try {
        // Delete from server
        await fetch('https://localhost:43098/api/tampon/delete', {
            method: 'DELETE'
        });

        anonymization.tamponImage = null;
        document.getElementById('tamponPreview').style.display = 'none';
        document.getElementById('tamponPreviewImage').src = '';
        document.getElementById('tamponImageInput').value = '';

        // Delete from localStorage
        localStorage.removeItem('piecemaker_tampon_filename');

        if (addMessageFn) addMessageFn('system', '🗑️ Tampon supprimé.');
    } catch (error) {
        console.error('[Tampon] Erreur suppression:', error);
        if (addMessageFn) addMessageFn('system', '❌ Erreur lors de la suppression du tampon : ' + error.message);
    }
}

/**
 * Load tampon from storage on startup
 */
async function loadTamponFromStorage() {
    const filename = localStorage.getItem('piecemaker_tampon_filename');
    if (!filename) {
        return;
    }

    try {
        const response = await fetch('https://localhost:43098/api/tampon/load');

        if (response.ok) {
            const result = await response.json();
            if (result.tamponImage) {
                anonymization.tamponImage = result.tamponImage;
                console.log('[Tampon] Tampon chargé depuis le serveur');
            }
        }
    } catch (error) {
        console.error('[Tampon] Erreur chargement:', error);
    }
}

/**
 * Update files list display
 */
function updateFilesListDisplay() {
    const container = document.getElementById('filesListContainer');

    if (!anonymization.selectedFiles || anonymization.selectedFiles.length === 0) {
        container.innerHTML = '<div class="empty-files">Aucun fichier chargé</div>';
        return;
    }

    container.innerHTML = anonymization.selectedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-info">
                <div class="file-name">📄 ${file.name || 'Document ' + (index + 1)}</div>
                <div class="file-meta">${file.id || 'ID: ' + index}</div>
            </div>
        </div>
    `).join('');
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize event listeners for anonymization features
 * Call this function from taskpane.js after DOM is ready
 */
function initAnonymizationListeners(eventHandlers) {
    // Mapping modal listeners
    const closeMappingBtn = document.getElementById('closeMappingModal');
    if (closeMappingBtn) {
        closeMappingBtn.onclick = () => {
            document.getElementById('mappingModal').style.display = 'none';
        };
    }

    const validateMappingBtn = document.getElementById('validateMappingBtn');
    if (validateMappingBtn && eventHandlers.validateMapping) {
        validateMappingBtn.onclick = eventHandlers.validateMapping;
    }

    // Dossier info modal listeners
    const closeDossierInfoBtn = document.getElementById('closeDossierInfoModal');
    if (closeDossierInfoBtn) {
        closeDossierInfoBtn.onclick = closeDossierInfoModal;
    }

    const cancelDossierInfoBtn = document.getElementById('cancelDossierInfo');
    if (cancelDossierInfoBtn) {
        cancelDossierInfoBtn.onclick = closeDossierInfoModal;
    }

    const saveDossierInfoBtn = document.getElementById('saveDossierInfo');
    if (saveDossierInfoBtn && eventHandlers.saveDossierInfo) {
        saveDossierInfoBtn.onclick = eventHandlers.saveDossierInfo;
    }

    // Tampon modal listeners
    const closeTamponBtn = document.getElementById('closeTamponModal');
    if (closeTamponBtn) {
        closeTamponBtn.onclick = closeTamponModal;
    }

    const tamponImageInput = document.getElementById('tamponImageInput');
    if (tamponImageInput && eventHandlers.handleTamponImageUpload) {
        tamponImageInput.onchange = eventHandlers.handleTamponImageUpload;
    }

    const saveTamponBtn = document.getElementById('saveTamponBtn');
    if (saveTamponBtn && eventHandlers.saveTampon) {
        saveTamponBtn.onclick = eventHandlers.saveTampon;
    }

    const clearTamponBtn = document.getElementById('clearTamponBtn');
    if (clearTamponBtn && eventHandlers.clearTampon) {
        clearTamponBtn.onclick = eventHandlers.clearTampon;
    }

    // Load tampon on startup
    loadTamponFromStorage();
}

// ============================================
// EXPORTS
// ============================================

// For ES modules
export {
    // State
    anonymization,

    // Core functions (CRITICAL - DO NOT BREAK)
    anonymizeText,

    // Mapping management
    showMappingValidation,
    validateMapping,
    reopenMappingModal,
    mergeMappingWithDossierInfo,
    convertFlatToHierarchical,
    refreshMappingModal,

    // Mapping editing
    addVariant,
    deleteVariant,
    deleteMappingItem,
    addMappingItem,
    getCategoryIcon,

    // Dossier info
    openDossierInfoModal,
    closeDossierInfoModal,
    addPartieCliente,
    addPartieAdverse,
    deletePartieCliente,
    deletePartieAdverse,
    updatePartieClienteFields,
    updatePartieAdverseFields,
    collectDossierInfo,
    loadDossierInfo,
    saveDossierInfoAndContinue,

    // Tampon
    openTamponModal,
    closeTamponModal,
    handleTamponImageUpload,
    saveTampon,
    clearTampon,
    loadTamponFromStorage,
    updateFilesListDisplay,

    // Initialization
    initAnonymizationListeners
};

// For global access (used by onclick handlers in HTML)
if (typeof window !== 'undefined') {
    window.anonymization = {
        anonymizeText,
        showMappingValidation,
        validateMapping,
        reopenMappingModal,
        mergeMappingWithDossierInfo,
        addVariant,
        deleteVariant,
        deleteMappingItem,
        addMappingItem,
        openDossierInfoModal,
        closeDossierInfoModal,
        addPartieCliente,
        addPartieAdverse,
        deletePartieCliente,
        deletePartieAdverse,
        updatePartieClienteFields,
        updatePartieAdverseFields,
        openTamponModal,
        closeTamponModal
    };
}
