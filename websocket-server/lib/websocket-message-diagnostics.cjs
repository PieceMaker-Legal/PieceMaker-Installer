'use strict';

// Les réponses du volet aux requêtes Word n'ont volontairement pas de `type` :
// elles sont corrélées par requestId dans l'écouteur propre à chaque requête.
function isWordToolResponse(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.requestId != null
    && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
  );
}

function describeUnknownWebSocketMessage(message) {
  if (!message || typeof message !== 'object') {
    return { type: '(absent)', requestId: '(absent)', keys: [] };
  }

  return {
    type: typeof message.type === 'string' && message.type ? message.type : '(absent)',
    requestId: message.requestId == null ? '(absent)' : String(message.requestId),
    keys: Object.keys(message).sort(),
  };
}

module.exports = { describeUnknownWebSocketMessage, isWordToolResponse };
