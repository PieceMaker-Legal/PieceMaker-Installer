/**
 * OLLAMA Analyzer - Analyse avec OLLAMA
 * Optimisé pour modèles légers (Ollama 3.2)
 * Traitement séquentiel pour éviter la surcharge
 */

// Dependencies injection
let deps = null;

export function initOllamaAnalyzer(dependencies) {
    deps = dependencies;
    
    // Initialiser les événements du modal
    Office.onReady(() => {
        // Fermer le modal
        document.getElementById('closeOllamaActionModal')?.addEventListener('click', () => {
            document.getElementById('ollamaActionModal').classList.remove('show');
        });

        // Bouton Anonymisation
        document.getElementById('ollamaAnonymizeBtn')?.addEventListener('click', ollamaAnonymize);

        // Bouton Analyse contextuelle
        document.getElementById('ollamaAnalyzeBtn')?.addEventListener('click', ollamaAnalyzeDocuments);
    });
}

// Fonction pour ouvrir le modal de choix d'action Ollama
export function analyzeWithOllama() {
    // Vérifier qu'il y a des fichiers chargés
    if (!anonymization.files || anonymization.files.length === 0) {
        deps.addMessageToDossierTab('system', '❌ Aucun fichier chargé. Veuillez d\'abord charger des fichiers via 📁 Fichiers.');
        return;
    }

    // Afficher le modal de choix
    document.getElementById('ollamaActionModal').classList.add('show');
}

// Fonction d'anonymisation avec OLLAMA (extraction des entités sensibles)
export async function ollamaAnonymize() {
    try {
        // Fermer le modal de choix
        document.getElementById('ollamaActionModal').classList.remove('show');

        // Récupérer la configuration OLLAMA
        const ollamaUrl = document.getElementById('ollamaUrl')?.value || 'http://localhost:11434';
        const modelName = document.getElementById('modelName')?.value;

        if (!modelName) {
            deps.addMessageToDossierTab('system', '❌ Veuillez sélectionner un modèle Ollama dans les paramètres.');
            document.getElementById('modal').classList.add('show');
            return;
        }

        deps.addMessageToDossierTab('system', `🔒 Début de l'anonymisation OLLAMA avec ${modelName}...`);
        deps.addMessageToDossierTab('system', `📊 ${anonymization.files.length} document(s) à analyser`);

        // Les fichiers sont déjà dans compilation_documents avec texte_integral
        const extractedTexts = anonymization.files.map(doc => ({
            fileName: doc.filename || 'document.txt',
            text: doc.texte_integral || ''
        }));

        if (extractedTexts.length === 0 || !extractedTexts[0].text) {
            deps.addMessageToDossierTab('system', '❌ Aucun texte trouvé dans les documents. Vérifiez que les fichiers sont bien chargés.');
            return;
        }

        deps.addMessageToDossierTab('system', `✅ ${extractedTexts.length} document(s) prêt(s) pour l'analyse`);

        // Envoyer au serveur pour analyse OLLAMA avec les informations du dossier
        const response = await fetch('https://localhost:43098/api/ollama/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                extractedTexts: extractedTexts,
                ollamaUrl: ollamaUrl,
                modelName: modelName,
                documentId: anonymization.documentId,
                dossierInfo: anonymization.dossierInfo || null
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors de l\'anonymisation OLLAMA');
        }

        const result = await response.json();

        deps.updateAnonymizationProgress({
            step: 'complete',
            current: 1,
            total: 1,
            message: 'Anonymisation terminée !'
        });

        // ✅ FUSION avec informations du dossier avant affichage
        if (anonymization.dossierInfo) {
            console.log('[Ollama] Fusion du mapping avec informations dossier...');
            const merged = deps.mergeMappingWithDossierInfo(
                result.mapping,
                result.reverse_mapping,
                anonymization.dossierInfo
            );
            result.mapping = merged.mapping;
            result.reverse_mapping = merged.reverse_mapping;

            deps.addMessageToDossierTab('system', `🔄 Mapping fusionné avec les parties du dossier`);
        }

        // Afficher le mapping pour validation
        deps.showMappingValidation(result);

    } catch (error) {
        console.error('Erreur anonymisation OLLAMA:', error);
        deps.addMessageToDossierTab('system', `❌ Erreur: ${error.message}`);

        deps.updateAnonymizationProgress({
            step: 'complete',
            current: 0,
            total: 0,
            message: 'Erreur lors de l\'anonymisation'
        });
    }
}

// Fonction d'analyse contextuelle des documents avec OLLAMA
export async function ollamaAnalyzeDocuments() {
    try {
        // Fermer le modal de choix
        document.getElementById('ollamaActionModal').classList.remove('show');

        // Récupérer la configuration OLLAMA
        const ollamaUrl = document.getElementById('ollamaUrl')?.value || 'http://localhost:11434';
        const modelName = document.getElementById('modelName')?.value;

        if (!modelName) {
            deps.addMessageToDossierTab('system', '❌ Veuillez sélectionner un modèle Ollama dans les paramètres.');
            document.getElementById('modal').classList.add('show');
            return;
        }

        deps.addMessageToDossierTab('system', `📄 Début de l'analyse contextuelle avec ${modelName}...`);
        deps.addMessageToDossierTab('system', `📊 ${anonymization.files.length} document(s) à analyser`);

        // Les fichiers sont déjà dans compilation_documents avec texte_integral
        const extractedTexts = anonymization.files.map(doc => ({
            fileName: doc.filename || 'document.txt',
            text: doc.texte_integral || ''
        }));

        if (extractedTexts.length === 0 || !extractedTexts[0].text) {
            deps.addMessageToDossierTab('system', '❌ Aucun texte trouvé dans les documents. Vérifiez que les fichiers sont bien chargés.');
            return;
        }

        deps.addMessageToDossierTab('system', `✅ ${extractedTexts.length} document(s) prêt(s) pour l'analyse`);

        // Envoyer au serveur pour analyse contextuelle
        const response = await fetch('https://localhost:43098/api/ollama/analyze-documents', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                extractedTexts: extractedTexts,
                ollamaUrl: ollamaUrl,
                modelName: modelName,
                documentId: anonymization.documentId
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors de l\'analyse contextuelle');
        }

        const result = await response.json();

        deps.updateAnonymizationProgress({
            step: 'complete',
            current: 1,
            total: 1,
            message: 'Analyse terminée !'
        });

        // Mettre à jour la compilation_documents avec les analyses
        if (result.analyses && result.analyses.length > 0) {
            result.analyses.forEach((analysis, index) => {
                if (anonymization.files[index]) {
                    anonymization.files[index].type_document = analysis.type_document;
                    anonymization.files[index].date_document = analysis.date_document;
                    anonymization.files[index].analyse = analysis.analyse;
                }
            });

            // Sauvegarder la compilation mise à jour
            await saveCompilationToServer();

            deps.addMessageToDossierTab('system', `✅ Analyse terminée et enregistrée dans la compilation !`);
            deps.addMessageToDossierTab('system', `📋 Résultats :`);
            result.analyses.forEach((analysis, index) => {
                deps.addMessageToDossierTab('system', `\n📄 ${analysis.fileName}`);
                deps.addMessageToDossierTab('system', `   Type: ${analysis.type_document || 'Non déterminé'}`);
                deps.addMessageToDossierTab('system', `   Date: ${analysis.date_document || 'Non trouvée'}`);
                deps.addMessageToDossierTab('system', `   Analyse: ${analysis.analyse.substring(0, 200)}...`);
            });
        }

    } catch (error) {
        console.error('Erreur analyse contextuelle OLLAMA:', error);
        deps.addMessageToDossierTab('system', `❌ Erreur: ${error.message}`);

        deps.updateAnonymizationProgress({
            step: 'complete',
            current: 0,
            total: 0,
            message: 'Erreur lors de l\'analyse'
        });
    }
}

// Fonction pour sauvegarder la compilation mise à jour sur le serveur
async function saveCompilationToServer() {
    try {
        const response = await fetch('https://localhost:43098/api/save-compilation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: anonymization.documentId,
                compilation_documents: anonymization.files
            })
        });

        if (!response.ok) {
            throw new Error('Erreur lors de la sauvegarde');
        }

        console.log('✅ Compilation sauvegardée sur le serveur');
    } catch (error) {
        console.error('❌ Erreur sauvegarde compilation:', error);
        throw error;
    }
}
