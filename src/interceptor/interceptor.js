(function () {
  try {
    if (window.__CUP_FETCH_PATCHED__) {
      return;
    }

    if (typeof window.fetch !== 'function') {
      return;
    }

    window.__CUP_FETCH_PATCHED__ = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = function patchedFetch(input, init) {
      try {
        const requestUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';

        return originalFetch(input, init)
          .then(function (response) {
            try {
              const isApiRequest =
                typeof requestUrl === 'string' &&
                (requestUrl.includes('api.claude.ai') || requestUrl.includes('/api/'));

              if (isApiRequest) {
                response
                  .clone()
                  .json()
                  .then(function (payload) {
                    try {
                      window.postMessage(
                        {
                          source: 'cup-interceptor',
                          type: 'CLAUDE_API_DATA',
                          url: requestUrl,
                          payload: payload,
                        },
                        '*',
                      );
                    } catch (_postMessageError) {
                      // Ignore postMessage errors to keep fetch behavior untouched.
                    }
                  })
                  .catch(function (_parseError) {
                    // Ignore parse failures and keep original response flow.
                  });
              }
            } catch (_responseProcessingError) {
              // Ignore response processing failures.
            }

            return response;
          })
          .catch(function (error) {
            return Promise.reject(error);
          });
      } catch (_unexpectedError) {
        try {
          return originalFetch(input, init);
        } catch (error) {
          return Promise.reject(error);
        }
      }
    };
  } catch (_setupError) {
    // Ignore setup failures to avoid breaking page behavior.
  }
})();
