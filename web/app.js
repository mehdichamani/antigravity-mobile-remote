// Antigravity Mobile Remote Client Logic
(function () {
  'use strict';

  // --- State Variables ---
  let ws = null;
  let isConnected = false;
  let isTurnActive = false;
  let currentAssistantMsgId = null;
  let currentAssistantCard = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let speechRecognizer = null;
  let isRecordingVoice = false;

  // Settings & Preferences (stored in localStorage)
  let soundEnabled = localStorage.getItem('ag_sound') !== 'false';
  let hapticsEnabled = localStorage.getItem('ag_haptics') !== 'false';
  let currentEffort = localStorage.getItem('ag_effort') || 'low'; // low, medium, high
  let currentDirection = localStorage.getItem('ag_chat_dir') || 'ltr'; // ltr, rtl
  let currentWorkspacePath = '';

  // Audio Context for Web Audio API Synth Chimes
  let audioCtx = null;

  // --- DOM Elements ---
  const chatFeed = document.getElementById('chatFeed');
  const welcomeCard = document.getElementById('welcomeCard');
  const promptInput = document.getElementById('promptInput');
  const actionBtn = document.getElementById('actionBtn');
  const micBtn = document.getElementById('micBtn');
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const liveBanner = document.getElementById('liveBanner');
  const liveBannerText = document.getElementById('liveBannerText');
  const bannerCancelBtn = document.getElementById('bannerCancelBtn');
  const effortBtn = document.getElementById('effortBtn');
  const dirToggleBtn = document.getElementById('dirToggleBtn');
  const soundToggleBtn = document.getElementById('soundToggleBtn');
  const hapticToggleBtn = document.getElementById('hapticToggleBtn');
  const clearBtn = document.getElementById('clearBtn');
  const changeDirBtn = document.getElementById('changeDirBtn');
  const cwdText = document.getElementById('cwdText');
  const continueSessionCheckbox = document.getElementById('continueSessionCheckbox');
  const workspaceModal = document.getElementById('workspaceModal');
  const workspaceInput = document.getElementById('workspaceInput');
  const workspaceError = document.getElementById('workspaceError');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const saveWorkspaceBtn = document.getElementById('saveWorkspaceBtn');

  // --- Initialize UI State ---
  updateEffortUI();
  updateSoundUI();
  updateHapticsUI();
  updateDirectionUI();

  // --- WebSocket Connection ---
  function connectWebSocket() {
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    updateConnectionUI('connecting');

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[WS] Connection failed:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[WS] Connected to Antigravity Remote Server');
      isConnected = true;
      updateConnectionUI('online');

      // Heartbeat every 15 seconds
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
      } catch (err) {
        console.error('[WS] Error parsing message:', err, event.data);
      }
    };

    ws.onclose = () => {
      console.warn('[WS] Disconnected');
      isConnected = false;
      clearInterval(pingTimer);
      updateConnectionUI('offline');
      setTurnState(false);
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[WS] WebSocket error:', err);
      ws.close();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log('[WS] Attempting reconnection...');
      connectWebSocket();
    }, 2500);
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'init':
        handleInit(msg.payload);
        break;

      case 'turn_started':
        setTurnState(true);
        if (msg.payload.userMsg) {
          appendUserMessage(msg.payload.userMsg);
        }
        currentAssistantMsgId = msg.payload.assistantMsgId;
        currentAssistantCard = createAssistantCard(currentAssistantMsgId);
        chatFeed.appendChild(currentAssistantCard);
        scrollToBottom();
        break;

      case 'text_delta':
        if (!currentAssistantCard) {
          currentAssistantCard = createAssistantCard(msg.payload.assistantMsgId);
          chatFeed.appendChild(currentAssistantCard);
        }
        updateAssistantText(currentAssistantCard, msg.payload.fullText);
        scrollToBottom();
        break;

      case 'tool_update':
        if (!currentAssistantCard) {
          currentAssistantCard = createAssistantCard(msg.payload.assistantMsgId);
          chatFeed.appendChild(currentAssistantCard);
        }
        updateAssistantTools(currentAssistantCard, msg.payload.allTools || [msg.payload.tool]);
        scrollToBottom();
        break;

      case 'turn_result':
        if (currentAssistantCard && msg.payload.result) {
          updateAssistantResult(currentAssistantCard, msg.payload.result);
        }
        break;

      case 'turn_finished':
      case 'turn_done':
        setTurnState(false);
        triggerCompletionFeedback();
        break;

      case 'turn_cancelled':
        setTurnState(false);
        if (currentAssistantCard) {
          const prose = currentAssistantCard.querySelector('.prose');
          if (prose) {
            prose.innerHTML += '<p style="color: var(--accent-rose); font-weight: 600;">⚠️ Turn cancelled by user.</p>';
          }
        }
        break;

      case 'history_cleared':
        clearChatUI();
        break;

      case 'workspace_changed':
        if (msg.cwd) {
          cwdText.textContent = formatPath(msg.cwd);
          cwdText.title = msg.cwd;
          currentWorkspacePath = msg.cwd;
        }
        break;

      case 'error':
        alert(msg.message || 'Error from agent server');
        setTurnState(false);
        break;

      default:
        break;
    }
  }

  function handleInit(payload) {
    if (payload.cwd) {
      currentWorkspacePath = payload.cwd;
      cwdText.textContent = formatPath(payload.cwd);
      cwdText.title = payload.cwd;
    }

    if (payload.isTurnActive) {
      setTurnState(true);
    }

    // Render historical messages if any
    if (payload.history && payload.history.length > 0) {
      hideWelcome();
      chatFeed.innerHTML = '';
      for (const item of payload.history) {
        if (item.role === 'user') {
          appendUserMessage(item);
        } else if (item.role === 'assistant') {
          const card = createAssistantCard(item.id);
          chatFeed.appendChild(card);
          if (item.text) {
            updateAssistantText(card, item.text);
          }
          if (item.tools && item.tools.length > 0) {
            updateAssistantTools(card, item.tools);
          }
          if (item.duration || item.usage) {
            updateAssistantResult(card, { duration_seconds: item.duration, usage: item.usage });
          }
        }
      }
      scrollToBottom();
    }
  }

  // --- Turn & UI Controls ---
  function setTurnState(active) {
    isTurnActive = active;
    const sendIcon = actionBtn.querySelector('.send-icon');
    const stopIcon = actionBtn.querySelector('.stop-icon');

    if (active) {
      actionBtn.classList.add('cancel-mode');
      actionBtn.title = 'Stop agent';
      sendIcon.classList.add('hidden');
      stopIcon.classList.remove('hidden');

      liveBanner.classList.remove('hidden');
      liveBannerText.textContent = 'Agent is processing prompt...';
      updateConnectionUI('busy');
    } else {
      actionBtn.classList.remove('cancel-mode');
      actionBtn.title = 'Send prompt';
      sendIcon.classList.remove('hidden');
      stopIcon.classList.add('hidden');

      liveBanner.classList.add('hidden');
      if (isConnected) {
        updateConnectionUI('online');
      }
      currentAssistantMsgId = null;
      currentAssistantCard = null;
    }
  }

  function updateConnectionUI(state) {
    statusPill.className = 'status-pill ' + state;
    if (state === 'online') {
      statusText.textContent = 'Connected';
    } else if (state === 'busy') {
      statusText.textContent = 'Working';
    } else if (state === 'connecting') {
      statusText.textContent = 'Connecting...';
    } else {
      statusText.textContent = 'Offline';
    }
  }

  // --- Chat Message Rendering ---
  function hideWelcome() {
    if (welcomeCard) {
      welcomeCard.classList.add('hidden');
    }
  }

  function appendUserMessage(msg) {
    hideWelcome();
    const row = document.createElement('div');
    row.className = 'message-row user';
    row.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = msg.text;

    row.appendChild(bubble);
    chatFeed.appendChild(row);
    scrollToBottom();
  }

  function createAssistantCard(id) {
    hideWelcome();
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    if (id) row.id = id;

    const card = document.createElement('div');
    card.className = 'assistant-card';

    // Card Header
    const header = document.createElement('div');
    header.className = 'assistant-header';
    header.innerHTML = `
      <div class="assistant-title-group">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <span>Antigravity</span>
      </div>
      <div class="assistant-meta"></div>
    `;

    // Tools Container
    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'tools-container hidden';

    // Prose (Markdown text)
    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.innerHTML = '<span class="thinking-pill">Thinking...</span>';

    card.appendChild(header);
    card.appendChild(toolsContainer);
    card.appendChild(prose);
    row.appendChild(card);

    return row;
  }

  function updateAssistantText(cardRow, fullText) {
    const prose = cardRow.querySelector('.prose');
    if (!prose) return;
    prose.innerHTML = renderMarkdown(fullText);
    setupCodeCopyButtons(prose);
  }

  function updateAssistantTools(cardRow, tools) {
    const container = cardRow.querySelector('.tools-container');
    if (!container) return;

    if (!tools || tools.length === 0) {
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = '';

    for (const tool of tools) {
      const toolCard = document.createElement('div');
      toolCard.className = 'tool-card';

      const statusClass = tool.state === 'DONE' ? 'done' : tool.state === 'ERROR' ? 'error' : 'active';
      const statusLabel = tool.state === 'DONE' ? '✓ DONE' : tool.state === 'ERROR' ? '✗ ERROR' : 'RUNNING...';

      let detailsContent = '';
      if (tool.parameters) {
        detailsContent += `Params: ${JSON.stringify(tool.parameters, null, 2)}\n`;
      }
      if (tool.output) {
        detailsContent += `Output:\n${tool.output}\n`;
      }
      if (tool.error) {
        detailsContent += `Error:\n${tool.error}\n`;
      }

      toolCard.innerHTML = `
        <div class="tool-header">
          <div class="tool-left">
            <span>⚙️ ${escapeHtml(tool.name)}</span>
          </div>
          <span class="tool-status-badge ${statusClass}">${statusLabel}</span>
        </div>
        ${detailsContent ? `<div class="tool-body hidden">${escapeHtml(detailsContent.trim())}</div>` : ''}
      `;

      // Toggle tool body expand/collapse
      const header = toolCard.querySelector('.tool-header');
      const body = toolCard.querySelector('.tool-body');
      if (header && body) {
        header.addEventListener('click', () => {
          body.classList.toggle('hidden');
        });
      }

      container.appendChild(toolCard);
    }
  }

  function updateAssistantResult(cardRow, result) {
    const metaContainer = cardRow.querySelector('.assistant-meta');
    if (!metaContainer) return;

    let metaHtml = '';
    if (result.duration_seconds) {
      const dur = parseFloat(result.duration_seconds).toFixed(1);
      metaHtml += `<span class="meta-tag">⏱️ ${dur}s</span>`;
    }
    if (result.usage && result.usage.total_tokens) {
      metaHtml += `<span class="meta-tag">🧮 ${result.usage.total_tokens} tokens</span>`;
    }
    metaContainer.innerHTML = metaHtml;
  }

  // --- Prompt Submission & Controls ---
  function sendPrompt() {
    const text = promptInput.value.trim();
    if (!text) return;

    if (!isConnected) {
      alert('Cannot send: disconnected from desktop agent.');
      return;
    }

    if (isTurnActive) {
      // If currently active, this button acts as Stop/Cancel
      cancelPrompt();
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'prompt',
        text,
        effort: currentEffort,
        continueSession: continueSessionCheckbox.checked,
        cwd: currentWorkspacePath || undefined,
      })
    );

    promptInput.value = '';
    adjustTextareaHeight();
  }

  function cancelPrompt() {
    if (ws && isConnected) {
      ws.send(JSON.stringify({ type: 'cancel' }));
      liveBannerText.textContent = 'Cancelling...';
    }
  }

  function clearChatUI() {
    chatFeed.innerHTML = '';
    if (welcomeCard) {
      welcomeCard.classList.remove('hidden');
      chatFeed.appendChild(welcomeCard);
    }
  }

  // --- Audio Synth & Haptic Feedback ---
  function triggerCompletionFeedback() {
    // 1. Haptic Vibration (native Android / Samsung S24)
    if (hapticsEnabled && 'vibrate' in navigator) {
      try {
        navigator.vibrate([45, 80, 45]);
      } catch (e) {
        // Ignore vibration error
      }
    }

    // 2. Pleasant Two-Tone Audio Synth Chime (Web Audio API)
    if (soundEnabled) {
      playChime();
    }
  }

  function playChime() {
    try {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const now = audioCtx.currentTime;

      // Note 1: D5 (587.33 Hz)
      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.exponentialRampToValueAtTime(0.18, now + 0.03);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc1.connect(gain1);
      gain1.connect(audioCtx.destination);
      osc1.start(now);
      osc1.stop(now + 0.18);

      // Note 2: A5 (880.00 Hz)
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880.0, now + 0.1);
      gain2.gain.setValueAtTime(0.001, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.22, now + 0.14);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.45);
    } catch (err) {
      console.warn('Audio feedback failed:', err);
    }
  }

  // --- Voice Input (Web Speech API) ---
  function setupVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      micBtn.style.display = 'none';
      return;
    }

    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = false;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = 'en-US';

    speechRecognizer.onstart = () => {
      isRecordingVoice = true;
      micBtn.classList.add('listening');
      promptInput.placeholder = 'Listening... Speak now';
    };

    speechRecognizer.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        transcript += event.results[i][0].transcript;
      }
      promptInput.value = transcript;
      adjustTextareaHeight();
    };

    speechRecognizer.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      stopVoiceInput();
    };

    speechRecognizer.onend = () => {
      stopVoiceInput();
    };
  }

  function toggleVoiceInput() {
    if (!speechRecognizer) return;
    if (isRecordingVoice) {
      speechRecognizer.stop();
      stopVoiceInput();
    } else {
      try {
        speechRecognizer.start();
      } catch (err) {
        console.error('Failed to start speech recognition:', err);
      }
    }
  }

  function stopVoiceInput() {
    isRecordingVoice = false;
    micBtn.classList.remove('listening');
    promptInput.placeholder = 'Message Antigravity...';
  }

  // --- Settings & UI Helpers ---
  function updateEffortUI() {
    const effortTag = effortBtn.querySelector('.effort-tag');
    effortTag.textContent = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1);
  }

  function updateSoundUI() {
    if (soundEnabled) {
      soundToggleBtn.classList.add('active');
    } else {
      soundToggleBtn.classList.remove('active');
    }
  }

  function updateHapticsUI() {
    if (hapticsEnabled) {
      hapticToggleBtn.classList.add('active');
    } else {
      hapticToggleBtn.classList.remove('active');
    }
  }

  function updateDirectionUI() {
    if (!dirToggleBtn) return;
    const dirTag = dirToggleBtn.querySelector('.dir-tag');
    const inputContainer = document.querySelector('.input-container');

    if (currentDirection === 'rtl') {
      if (dirTag) dirTag.textContent = 'RTL';
      dirToggleBtn.classList.add('rtl-active');
      dirToggleBtn.title = 'Text Direction: RTL (Click for LTR)';
      chatFeed.classList.add('chat-rtl');
      if (inputContainer) inputContainer.classList.add('rtl-mode');
      promptInput.setAttribute('dir', 'rtl');
    } else {
      if (dirTag) dirTag.textContent = 'LTR';
      dirToggleBtn.classList.remove('rtl-active');
      dirToggleBtn.title = 'Text Direction: LTR (Click for RTL)';
      chatFeed.classList.remove('chat-rtl');
      if (inputContainer) inputContainer.classList.remove('rtl-mode');
      promptInput.setAttribute('dir', 'ltr');
    }
  }

  function adjustTextareaHeight() {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + 'px';
  }

  function scrollToBottom() {
    window.requestAnimationFrame(() => {
      chatFeed.scrollTop = chatFeed.scrollHeight;
    });
  }

  function formatPath(fullPath) {
    if (!fullPath) return '~';
    const home = '/home/unreal';
    if (fullPath.startsWith(home)) {
      return '~' + fullPath.slice(home.length);
    }
    return fullPath;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderMarkdown(md) {
    if (!md) return '';

    // Code blocks with syntax copy header
    let html = md.replace(/```([a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const language = lang || 'text';
      return `<div class="code-block-wrapper">
        <div class="code-header">
          <span>${escapeHtml(language)}</span>
          <button class="copy-code-btn" data-code="${escapeHtml(code)}">Copy</button>
        </div>
        <pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>
      </div>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italics
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Unordered lists
    html = html.replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Paragraph line breaks
    html = html.replace(/\n\n+/g, '</p><p>');
    html = `<p>${html}</p>`;
    html = html.replace(/<p><\/p>/g, '');

    return html;
  }

  function setupCodeCopyButtons(container) {
    container.querySelectorAll('.copy-code-btn').forEach((btn) => {
      btn.onclick = () => {
        const code = btn.getAttribute('data-code') || '';
        navigator.clipboard.writeText(code).then(() => {
          const original = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = original;
          }, 1500);
        });
      };
    });
  }

  // --- Event Listeners ---
  actionBtn.addEventListener('click', () => {
    if (isTurnActive) {
      cancelPrompt();
    } else {
      sendPrompt();
    }
  });

  bannerCancelBtn.addEventListener('click', cancelPrompt);

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  promptInput.addEventListener('input', adjustTextareaHeight);

  micBtn.addEventListener('click', toggleVoiceInput);

  effortBtn.addEventListener('click', () => {
    const sequence = ['low', 'medium', 'high'];
    const nextIdx = (sequence.indexOf(currentEffort) + 1) % sequence.length;
    currentEffort = sequence[nextIdx];
    localStorage.setItem('ag_effort', currentEffort);
    updateEffortUI();
  });

  if (dirToggleBtn) {
    dirToggleBtn.addEventListener('click', () => {
      currentDirection = currentDirection === 'rtl' ? 'ltr' : 'rtl';
      localStorage.setItem('ag_chat_dir', currentDirection);
      updateDirectionUI();
      if (hapticsEnabled && 'vibrate' in navigator) navigator.vibrate(30);
    });
  }

  soundToggleBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('ag_sound', soundEnabled.toString());
    updateSoundUI();
    if (soundEnabled) playChime();
  });

  hapticToggleBtn.addEventListener('click', () => {
    hapticsEnabled = !hapticsEnabled;
    localStorage.setItem('ag_haptics', hapticsEnabled.toString());
    updateHapticsUI();
    if (hapticsEnabled && 'vibrate' in navigator) navigator.vibrate(40);
  });

  clearBtn.addEventListener('click', () => {
    if (confirm('Clear chat session?')) {
      if (ws && isConnected) {
        ws.send(JSON.stringify({ type: 'clear' }));
      }
      clearChatUI();
    }
  });

  // --- Workspace Modal Handlers ---
  function openWorkspaceModal() {
    workspaceInput.value = currentWorkspacePath || '';
    workspaceError.classList.add('hidden');
    workspaceError.textContent = '';
    workspaceModal.classList.remove('hidden');
    setTimeout(() => {
      workspaceInput.focus();
      workspaceInput.select();
    }, 100);
  }

  function closeWorkspaceModal() {
    workspaceModal.classList.add('hidden');
    workspaceError.classList.add('hidden');
  }

  async function submitWorkspaceChange() {
    const newPath = workspaceInput.value.trim();
    if (!newPath) {
      workspaceError.textContent = 'Please enter a valid directory path.';
      workspaceError.classList.remove('hidden');
      return;
    }

    saveWorkspaceBtn.disabled = true;
    saveWorkspaceBtn.textContent = 'Switching...';

    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      });
      const data = await res.json();
      if (data.ok) {
        currentWorkspacePath = data.cwd;
        cwdText.textContent = formatPath(data.cwd);
        cwdText.title = data.cwd;
        closeWorkspaceModal();
        if (hapticsEnabled && 'vibrate' in navigator) navigator.vibrate(50);
      } else {
        workspaceError.textContent = data.error || 'Failed to switch workspace.';
        workspaceError.classList.remove('hidden');
      }
    } catch (err) {
      // Fallback via WebSocket
      if (ws && isConnected) {
        ws.send(JSON.stringify({ type: 'change_workspace', path: newPath }));
        closeWorkspaceModal();
      } else {
        workspaceError.textContent = 'Failed to connect to server: ' + err.message;
        workspaceError.classList.remove('hidden');
      }
    } finally {
      saveWorkspaceBtn.disabled = false;
      saveWorkspaceBtn.textContent = 'Switch Directory';
    }
  }

  if (changeDirBtn) {
    changeDirBtn.addEventListener('click', openWorkspaceModal);
  }
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', closeWorkspaceModal);
  }
  if (cancelModalBtn) {
    cancelModalBtn.addEventListener('click', closeWorkspaceModal);
  }
  if (saveWorkspaceBtn) {
    saveWorkspaceBtn.addEventListener('click', submitWorkspaceChange);
  }
  if (workspaceInput) {
    workspaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitWorkspaceChange();
      } else if (e.key === 'Escape') {
        closeWorkspaceModal();
      }
    });
  }
  if (workspaceModal) {
    workspaceModal.addEventListener('click', (e) => {
      if (e.target === workspaceModal) {
        closeWorkspaceModal();
      }
    });
  }

  // Quick chips clicks
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        promptInput.value = prompt;
        sendPrompt();
      }
    });
  });

  // Setup Voice & Connect WebSocket on load
  setupVoiceInput();
  connectWebSocket();
})();
