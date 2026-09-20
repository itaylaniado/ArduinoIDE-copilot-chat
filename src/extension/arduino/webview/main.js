/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and Arduino Copilot Chat contributors.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

(function () {
	let vscode;
	try {
		vscode = acquireVsCodeApi();
	} catch (e) {
		console.warn('[Arduino Copilot] acquireVsCodeApi fallback:', e);
		vscode = {
			postMessage: (msg) => console.log('[Webview mock postMessage]', msg),
			setState: () => {},
			getState: () => ({})
		};
	}

	const messagesContainer = document.getElementById('messages');
	const chatInput = document.getElementById('chat-input');
	const sendBtn = document.getElementById('send-btn');
	const boardChip = document.getElementById('active-board-chip');
	const portChip = document.getElementById('active-port-chip');
	const refreshBoardBtn = document.getElementById('refresh-board-btn');
	const authBtn = document.getElementById('auth-btn');
	const authLabel = document.getElementById('auth-label');
	let isCurrentlySignedIn = authBtn ? authBtn.classList.contains('signed-in') : false;

	if (authBtn) {
		authBtn.addEventListener('click', () => {
			if (isCurrentlySignedIn) {
				vscode.postMessage({ command: 'signOut' });
			} else {
				vscode.postMessage({ command: 'signIn' });
			}
		});
	}

	let currentAssistantBubble = null;
	let currentAssistantText = '';

	// Request initial auth status
	vscode.postMessage({ command: 'getAuthStatus' });

	// Handle sending messages
	function sendCurrentMessage() {
		if (!chatInput) return;
		const text = chatInput.value.trim();
		if (!text) return;

		// 1. Add User message bubble
		appendUserMessage(text);
		chatInput.value = '';
		chatInput.style.height = 'auto';

		// 2. Prepare Assistant reply bubble
		const replyId = 'msg_' + Date.now();
		currentAssistantBubble = createAssistantMessage(replyId);
		currentAssistantText = '';

		// 3. Post to extension
		vscode.postMessage({
			command: 'sendMessage',
			text,
			replyId
		});
	}

	if (sendBtn) {
		sendBtn.addEventListener('click', sendCurrentMessage);
	}

	if (chatInput) {
		chatInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendCurrentMessage();
				return;
			}

			// Explicit Cmd+V / Ctrl+V clipboard paste fallback for Electron webviews
			if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
				if (navigator.clipboard && navigator.clipboard.readText) {
					navigator.clipboard.readText().then((clipText) => {
						if (!clipText) return;
						const start = chatInput.selectionStart;
						const end = chatInput.selectionEnd;
						const val = chatInput.value;
						chatInput.value = val.substring(0, start) + clipText + val.substring(end);
						chatInput.selectionStart = chatInput.selectionEnd = start + clipText.length;
						chatInput.dispatchEvent(new Event('input'));
					}).catch(() => {
						// Default browser paste handler may still proceed
					});
				}
			}

			// Explicit Cmd+C / Ctrl+C copy
			if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
				const start = chatInput.selectionStart;
				const end = chatInput.selectionEnd;
				if (start !== end && navigator.clipboard && navigator.clipboard.writeText) {
					const text = chatInput.value.substring(start, end);
					navigator.clipboard.writeText(text).catch(() => {});
				}
			}

			// Explicit Cmd+X / Ctrl+X cut
			if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
				const start = chatInput.selectionStart;
				const end = chatInput.selectionEnd;
				if (start !== end && navigator.clipboard && navigator.clipboard.writeText) {
					const text = chatInput.value.substring(start, end);
					navigator.clipboard.writeText(text).then(() => {
						const val = chatInput.value;
						chatInput.value = val.substring(0, start) + val.substring(end);
						chatInput.selectionStart = chatInput.selectionEnd = start;
						chatInput.dispatchEvent(new Event('input'));
					}).catch(() => {});
				}
			}

			// Explicit Cmd+A / Ctrl+A select-all
			if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
				e.preventDefault();
				chatInput.select();
			}
		});

		// Auto-resize input textarea
		chatInput.addEventListener('input', () => {
			chatInput.style.height = 'auto';
			chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
		});

		// Native paste handler (right-click paste / drag-and-drop text)
		chatInput.addEventListener('paste', () => {
			setTimeout(() => {
				chatInput.style.height = 'auto';
				chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
			}, 0);
		});
	}

	// Global copy handler so copying text from chat bubbles or code blocks works reliably
	document.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
			if (document.activeElement !== chatInput) {
				const sel = window.getSelection();
				if (sel && sel.toString().length > 0 && navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(sel.toString()).catch(() => {});
				}
			}
		}
	});

	// Quick Action Chips with event delegation
	document.addEventListener('click', (e) => {
		const target = e.target;
		if (!target) return;
		const chip = target.closest('.action-chip');
		if (chip) {
			const actionText = chip.getAttribute('data-action') || chip.textContent.trim();
			if (chatInput) {
				chatInput.value = actionText;
			}
			sendCurrentMessage();
		}
	});

	if (boardChip) {
		boardChip.addEventListener('click', () => {
			vscode.postMessage({ command: 'selectBoard' });
		});
	}

	if (refreshBoardBtn) {
		refreshBoardBtn.addEventListener('click', () => {
			vscode.postMessage({ command: 'refreshBoard' });
		});
	}

	// Listen to messages from extension host
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message) return;

		switch (message.type) {
			case 'chunk': {
				if (currentAssistantBubble && currentAssistantBubble.markdownContent) {
					currentAssistantText += message.chunk;
					renderMarkdown(currentAssistantBubble.markdownContent, currentAssistantText);
					scrollToBottom();
				}
				break;
			}
			case 'toolStatus': {
				if (currentAssistantBubble && currentAssistantBubble.toolBadges) {
					updateToolBadge(currentAssistantBubble.toolBadges, message.toolName, message.status, message.result);
					scrollToBottom();
				}
				break;
			}
			case 'fileEdited': {
				if (currentAssistantBubble && currentAssistantBubble.bubble) {
					renderFileEditCard(currentAssistantBubble.bubble, message.filename, message.previousContent, message.explanation);
					scrollToBottom();
				}
				break;
			}
			case 'revertResult': {
				if (message.success) {
					const btns = document.querySelectorAll(`.file-edit-revert-btn[data-filename="${message.filename}"]`);
					btns.forEach(btn => {
						btn.textContent = '✓ Reverted';
						btn.classList.add('reverted');
						btn.disabled = true;
					});
				}
				break;
			}
			case 'updateBoardInfo': {
				if (boardChip && message.boardName) boardChip.textContent = message.boardName;
				if (portChip) portChip.textContent = message.port || 'No port';
				break;
			}
			case 'updateAuthStatus': {
				isCurrentlySignedIn = !!message.signedIn;
				if (authLabel) {
					authLabel.textContent = message.signedIn ? `👤 ${message.user}` : '🔑 Sign In';
				}
				if (authBtn) {
					if (message.signedIn) {
						authBtn.classList.add('signed-in');
						authBtn.title = `Signed in as ${message.user}. Click to sign out.`;
					} else {
						authBtn.classList.remove('signed-in');
						authBtn.title = 'Click to sign in with GitHub';
					}
				}
				break;
			}
		}
	});

	function appendUserMessage(text) {
		if (!messagesContainer) return;
		const row = document.createElement('div');
		row.className = 'message-row user';

		const sender = document.createElement('div');
		sender.className = 'message-sender';
		sender.textContent = 'You';

		const bubble = document.createElement('div');
		bubble.className = 'message-bubble';
		bubble.textContent = text;

		row.appendChild(sender);
		row.appendChild(bubble);
		messagesContainer.appendChild(row);
		scrollToBottom();
	}

	function createAssistantMessage(id) {
		const row = document.createElement('div');
		row.className = 'message-row assistant';
		row.id = id;

		const sender = document.createElement('div');
		sender.className = 'message-sender';
		sender.innerHTML = '<span>Arduino Copilot</span>';

		const bubble = document.createElement('div');
		bubble.className = 'message-bubble';

		const toolBadges = document.createElement('div');
		toolBadges.className = 'tool-badges';

		const markdownContent = document.createElement('div');
		markdownContent.className = 'markdown-content';

		bubble.appendChild(toolBadges);
		bubble.appendChild(markdownContent);

		row.appendChild(sender);
		row.appendChild(bubble);

		if (messagesContainer) {
			messagesContainer.appendChild(row);
		}
		scrollToBottom();

		return { row, bubble, toolBadges, markdownContent };
	}

	function updateToolBadge(container, toolName, status, result) {
		let badge = container.querySelector(`.tool-badge[data-tool="${toolName}"]`);
		if (!badge) {
			badge = document.createElement('div');
			badge.setAttribute('data-tool', toolName);
			container.appendChild(badge);
		}
		badge.className = `tool-badge ${status}`;

		const icon = status === 'running' ? '⏳' : status === 'done' ? '✓' : '⚠️';
		const label = toolName.replace('arduino_', '').replace(/_/g, ' ');
		badge.textContent = `${icon} ${label}${result ? ': ' + result : ''}`;
	}

	function renderFileEditCard(bubble, filename, previousContent, explanation) {
		let card = bubble.querySelector(`.file-edit-card[data-filename="${filename}"]`);
		if (card) {
			const exp = card.querySelector('.file-edit-explanation');
			if (exp && explanation) exp.textContent = explanation;
			return;
		}

		card = document.createElement('div');
		card.className = 'file-edit-card';
		card.setAttribute('data-filename', filename);

		const info = document.createElement('div');
		info.className = 'file-edit-info';

		const title = document.createElement('div');
		title.innerHTML = `⚡ Modified <span class="file-edit-filename">${escapeHtml(filename)}</span>`;

		const exp = document.createElement('div');
		exp.className = 'file-edit-explanation';
		exp.textContent = explanation;

		info.appendChild(title);
		info.appendChild(exp);

		const revertBtn = document.createElement('button');
		revertBtn.className = 'file-edit-revert-btn';
		revertBtn.setAttribute('data-filename', filename);
		revertBtn.textContent = '↩ Revert Edit';
		revertBtn.title = 'Undo this modification and restore previous code';
		revertBtn.addEventListener('click', () => {
			vscode.postMessage({
				command: 'revertEdit',
				filename: filename,
				previousContent: previousContent
			});
			revertBtn.textContent = 'Reverting...';
		});

		card.appendChild(info);
		card.appendChild(revertBtn);

		const markdownContent = bubble.querySelector('.markdown-content');
		if (markdownContent) {
			bubble.insertBefore(card, markdownContent);
		} else {
			bubble.appendChild(card);
		}
	}

	function renderMarkdown(container, rawText) {
		const lines = rawText.split('\n');
		let inCodeBlock = false;
		let codeLang = '';
		let codeContent = [];
		let inTable = false;
		let tableRows = [];
		let html = '';

		function flushTable() {
			if (!inTable) return;
			inTable = false;
			if (tableRows.length === 0) return;

			let tableHtml = '<table>';
			tableRows.forEach((r, idx) => {
				if (r.some(cell => /^:?-+:?$/.test(cell.trim()))) return;
				const tag = idx === 0 ? 'th' : 'td';
				tableHtml += '<tr>' + r.map(c => `<${tag}>${parseInline(c.trim())}</${tag}>`).join('') + '</tr>';
			});
			tableHtml += '</table>';
			html += tableHtml;
			tableRows = [];
		}

		for (const line of lines) {
			if (line.startsWith('```')) {
				if (inTable) flushTable();
				if (!inCodeBlock) {
					inCodeBlock = true;
					codeLang = line.replace('```', '').trim() || 'cpp';
					codeContent = [];
				} else {
					inCodeBlock = false;
					const rawCode = codeContent.join('\n');
					const codeString = escapeHtml(rawCode);
					html += `
					<div class="code-container">
						<div class="code-header">
							<span>${codeLang}</span>
							<div class="code-actions">
								<button class="code-action-btn apply-btn" data-code="${escapeHtml(rawCode)}">Apply to Sketch</button>
								<button class="code-action-btn copy-btn" data-code="${escapeHtml(rawCode)}">Copy</button>
							</div>
						</div>
						<pre><code>${codeString}</code></pre>
					</div>`;
				}
				continue;
			}

			if (inCodeBlock) {
				codeContent.push(line);
				continue;
			}

			// Table rows
			const trimmed = line.trim();
			if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
				inTable = true;
				const cells = trimmed.slice(1, -1).split('|');
				tableRows.push(cells);
				continue;
			} else if (inTable) {
				flushTable();
			}

			// Headers
			if (line.startsWith('### ')) {
				html += `<h3>${parseInline(line.slice(4))}</h3>`;
			} else if (line.startsWith('## ')) {
				html += `<h2>${parseInline(line.slice(3))}</h2>`;
			} else if (line.startsWith('# ')) {
				html += `<h2>${parseInline(line.slice(2))}</h2>`;
			} else if (line.startsWith('- ') || line.startsWith('* ')) {
				html += `<li>${parseInline(line.slice(2))}</li>`;
			} else if (/^\d+\.\s/.test(line)) {
				const match = line.match(/^\d+\.\s(.*)/);
				html += `<li>${parseInline(match ? match[1] : line)}</li>`;
			} else if (line.trim() === '') {
				html += '<br/>';
			} else {
				html += `<p>${parseInline(line)}</p>`;
			}
		}

		if (inTable) {
			flushTable();
		}

		container.innerHTML = html;

		// Attach listeners to "Apply to Sketch" and "Copy" buttons
		container.querySelectorAll('.apply-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const code = btn.getAttribute('data-code');
				vscode.postMessage({ command: 'applyToSketch', code });
				btn.textContent = 'Applied!';
				setTimeout(() => { btn.textContent = 'Apply to Sketch'; }, 2000);
			});
		});

		container.querySelectorAll('.copy-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const code = btn.getAttribute('data-code');
				navigator.clipboard.writeText(code);
				btn.textContent = 'Copied!';
				setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
			});
		});
	}

	function parseInline(text) {
		return escapeHtml(text)
			.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.*?)\*/g, '<em>$1</em>')
			.replace(/`([^`]+)`/g, '<code>$1</code>');
	}

	function escapeHtml(text) {
		const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
		return text.replace(/[&<>"']/g, (m) => map[m]);
	}

	function scrollToBottom() {
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}
})();

