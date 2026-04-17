(function () {
  try {
    if (window.__CUP_FETCH_PATCHED__) return;
    window.__CUP_FETCH_PATCHED__ = true;

    const originalFetch = window.fetch.bind(window);
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    // 1. SPA Navigation Tracking
    history.pushState = function (...args) {
      const res = originalPushState(...args);
      window.dispatchEvent(new CustomEvent('cup:urlchange'));
      return res;
    };
    history.replaceState = function (...args) {
      const res = originalReplaceState(...args);
      window.dispatchEvent(new CustomEvent('cup:urlchange'));
      return res;
    };

    // 2. Proactive Fetching Listener
    window.addEventListener('message', async (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === 'CUP_FETCH_INITIAL_DATA') {
        try {
          const orgRes = await originalFetch('/api/organizations');
          if (!orgRes.ok) return;
          const orgs = await orgRes.json();
          const orgId = orgs[0]?.uuid;
          if (!orgId) return;

          const usageRes = await originalFetch(`/api/organizations/${orgId}/usage`);
          if (usageRes.ok) {
            const usageData = await usageRes.json();
            window.postMessage({ source: 'cup-interceptor', type: 'CLAUDE_API_DATA', url: `/api/organizations/${orgId}/usage`, payload: usageData }, '*');
          }

          const match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9-]+)/);
          if (match) {
            const chatId = match[1];
            const chatRes = await originalFetch(`/api/organizations/${orgId}/chat_conversations/${chatId}?tree=true`);
            if (chatRes.ok) {
              const chatData = await chatRes.json();
              window.postMessage({ source: 'cup-interceptor', type: 'CLAUDE_API_DATA', url: `/api/organizations/${orgId}/chat_conversations/${chatId}`, payload: chatData }, '*');
            }
          }
        } catch (e) {}
      }
    });

    // 3. Stream Interception
    window.fetch = async function patchedFetch(input, init) {
      const requestUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
      
      try {
        const response = await originalFetch(input, init);
        const contentType = response.headers.get('content-type') || '';
        
        if (requestUrl.includes('api.claude.ai/api/') && !contentType.includes('event-stream')) {
          response.clone().json().then(payload => {
            window.postMessage({ source: 'cup-interceptor', type: 'CLAUDE_API_DATA', url: requestUrl, payload }, '*');
          }).catch(() => {});
          return response;
        }

        if (requestUrl.includes('api.claude.ai/api/') && contentType.includes('event-stream')) {
          const [stream1, stream2] = response.body.tee();
          const reader = stream1.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r\n|\r|\n/);
                buffer = lines.pop() || ''; 

                for (const line of lines) {
                  if (line.startsWith('data:')) {
                    const raw = line.slice(5).trim();
                    if (!raw) continue;
                    try {
                      const json = JSON.parse(raw);
                      window.postMessage({ source: 'cup-interceptor', type: 'CLAUDE_API_DATA', url: requestUrl, payload: json }, '*');
                    } catch (e) {}
                  }
                }
              }
            } catch (e) {}
          })();

          return new Response(stream2, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
        
        return response;
      } catch (error) {
        return Promise.reject(error);
      }
    };
  } catch (e) {}
})();
