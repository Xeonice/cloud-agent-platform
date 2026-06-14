(function () {
  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function setPressed(group, target) {
    qsa("button", group).forEach(function (button) {
      var active = button === target;
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-selected", String(active));
    });
  }

  function initSegmented() {
    qsa(".segmented").forEach(function (group) {
      group.addEventListener("click", function (event) {
        var button = event.target.closest("button");
        if (!button) return;
        setPressed(group, button);
        var output = group.dataset.output ? qs(group.dataset.output) : null;
        if (output) output.textContent = button.dataset.value || button.textContent.trim();
        if (group.dataset.filterTarget) applyFilter(group.dataset.filterTarget);
      });
    });
  }

  function activeFilterValue(root) {
    var button = qs(".segmented button[aria-pressed='true']", root) ||
      qs(".segmented button[aria-selected='true']", root);
    return button ? button.dataset.value || "all" : "all";
  }

  function textMatches(node, search) {
    if (!search) return true;
    return (node.dataset.search || node.textContent || "").toLowerCase().includes(search);
  }

  function applyFilter(id) {
    var root = qs("[data-filter-root='" + id + "']");
    if (!root) return;
    var search = (qs("[data-filter-search]", root)?.value || "").trim().toLowerCase();
    var filter = activeFilterValue(root);
    var visibleCount = 0;

    qsa("[data-filter-row]", root).forEach(function (row) {
      var level = row.dataset.level || row.dataset.state || "all";
      var levelMatch = filter === "all" || level === filter;
      var visible = levelMatch && textMatches(row, search);
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    });

    qsa("[data-filter-count]", root).forEach(function (node) {
      var count = visibleCount;
      if (node.dataset.countSelector) {
        count = qsa(node.dataset.countSelector, root).filter(function (row) {
          return !row.hidden;
        }).length;
      }
      var suffix = node.dataset.suffix || "";
      node.textContent = count + suffix;
    });
  }

  function initFilters() {
    qsa("[data-filter-root]").forEach(function (root) {
      var id = root.dataset.filterRoot;
      qsa("[data-filter-search]", root).forEach(function (input) {
        input.addEventListener("input", function () {
          applyFilter(id);
        });
      });
      applyFilter(id);
    });
  }

  function initTabs() {
    qsa("[data-tabs]").forEach(function (tablist) {
      tablist.addEventListener("click", function (event) {
        var button = event.target.closest("[role='tab']");
        if (!button) return;
        var panelId = button.getAttribute("aria-controls");
        qsa("[role='tab']", tablist).forEach(function (tab) {
          tab.setAttribute("aria-selected", String(tab === button));
        });
        qsa(".tab-panel", tablist.parentElement).forEach(function (panel) {
          panel.hidden = panel.id !== panelId;
        });
      });
    });
  }

  function initDialogs() {
    qsa("[data-open-dialog]").forEach(function (button) {
      button.addEventListener("click", function () {
        var dialog = qs(button.dataset.openDialog);
        if (dialog) dialog.hidden = false;
      });
    });
    qsa("[data-close-dialog]").forEach(function (button) {
      button.addEventListener("click", function () {
        var dialog = button.closest(".dialog-backdrop");
        if (dialog) dialog.hidden = true;
      });
    });
    qsa(".dialog-backdrop").forEach(function (backdrop) {
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) backdrop.hidden = true;
      });
    });
  }

  function repoFullName(value) {
    return value || "tanghehui/cloud-agent-platform";
  }

  function commandLines() {
    var repo = repoFullName(qs("#task-repo")?.value);
    var branch = qs("#task-branch")?.value || "main";
    var strategy = qs("#task-strategy")?.value || "single-pass";
    var prompt = (qs("#task-prompt")?.value || "").trim();
    var stopOnWrite = qs("#stop-on-write")?.checked !== false;
    var skills = qsa("[data-skill]:checked").map(function (input) {
      return "--skill " + input.value;
    });
    var lines = [
      "agentctl run \\",
      "  --repo " + repo + " \\",
      "  --branch " + branch + " \\",
      "  --strategy \"" + strategy + "\" \\",
      stopOnWrite ? "  --confirm-before-write \\" : "  --confirm-before-write=false \\"
    ];
    if (skills.length) lines.push("  " + skills.join(" ") + " \\");
    lines.push(prompt ? "  --prompt \"" + prompt.replace(/"/g, "\\\"") + "\"" : "  --prompt <待填写>");
    return lines;
  }

  function updateCommandPreview() {
    var preview = qs("[data-command-preview]");
    if (!preview) return;
    preview.innerHTML = "";
    commandLines().forEach(function (line) {
      var code = document.createElement("code");
      code.textContent = line;
      preview.appendChild(code);
    });
    var prompt = qs("#task-prompt");
    var count = qs("[data-task-count]");
    if (prompt && count) count.textContent = Array.from(prompt.value.trim()).length + " 字";
    var submit = qs("[data-task-submit]");
    if (submit && prompt) submit.disabled = prompt.value.trim().length === 0;
  }

  function initTaskForm() {
    qsa("[data-command-source]").forEach(function (node) {
      node.addEventListener("input", updateCommandPreview);
      node.addEventListener("change", updateCommandPreview);
    });
    updateCommandPreview();

    var form = qs("[data-task-form]");
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var prompt = (qs("#task-prompt")?.value || "").trim();
      var result = qs("[data-task-result]");
      if (!prompt) {
        var error = qs("[data-task-error]");
        if (error) {
          error.hidden = false;
          error.textContent = "创建失败：任务描述不能为空。";
        }
        return;
      }
      if (qs("[data-task-error]")) qs("[data-task-error]").hidden = true;
      if (result) result.hidden = false;
    });
  }

  function appendTerminalLine(message, className) {
    var terminal = qs("[data-terminal-log]");
    if (!terminal) return;
    var span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = message;
    terminal.appendChild(span);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function initTerminalActions() {
    qsa("[data-terminal-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.dataset.terminalAction;
        var terminalMenu = button.closest(".terminal-menu");
        if (action === "fullscreen") {
          var shell = button.closest("[data-terminal-shell]") || qs("[data-terminal-shell]");
          if (!shell) return;
          var active = document.fullscreenElement === shell || shell.classList.contains("is-fullscreen");
          if (active) {
            if (document.fullscreenElement && document.exitFullscreen) {
              document.exitFullscreen();
            } else {
              shell.classList.remove("is-fullscreen");
              button.setAttribute("aria-pressed", "false");
            }
            return;
          }
          if (shell.requestFullscreen) {
            var request = shell.requestFullscreen();
            button.setAttribute("aria-pressed", "true");
            if (request && request.catch) {
              request.catch(function () {
                button.setAttribute("aria-pressed", "false");
              });
            }
          } else {
            shell.classList.add("is-fullscreen");
            button.setAttribute("aria-pressed", "true");
          }
          return;
        }
        if (action === "pause") {
          var paused = button.getAttribute("aria-pressed") === "true";
          var pauseLabel = button.dataset.pauseLabel || "暂停";
          var resumeLabel = button.dataset.resumeLabel || "恢复";
          button.setAttribute("aria-pressed", String(!paused));
          button.textContent = paused ? pauseLabel : resumeLabel;
          appendTerminalLine(paused ? "stream resumed by operator" : "stream paused by operator", "muted");
          if (terminalMenu) terminalMenu.open = false;
          return;
        }
        if (action === "copy") {
          var terminal = qs("[data-terminal-log]");
          if (terminal && navigator.clipboard) {
            navigator.clipboard.writeText(terminal.textContent || "");
          }
          var old = button.dataset.originalText || button.textContent;
          button.dataset.originalText = old;
          button.textContent = "已复制";
          setTimeout(function () { button.textContent = old; }, 1200);
          if (terminalMenu) terminalMenu.open = false;
          return;
        }
        appendTerminalLine(button.dataset.line || action, button.dataset.lineClass || "muted");
        if (terminalMenu) terminalMenu.open = false;
      });
    });

    document.addEventListener("fullscreenchange", function () {
      qsa("[data-terminal-shell]").forEach(function (shell) {
        var active = document.fullscreenElement === shell;
        var button = qs("[data-terminal-action='fullscreen']", shell);
        if (!button) return;
        shell.classList.toggle("is-fullscreen", active);
        button.setAttribute("aria-pressed", String(active));
      });
    });
  }

  function initSessionPrompt() {
    qsa("[data-prompt-toggle]").forEach(function (prompt) {
      prompt.addEventListener("click", function () {
        var expanded = prompt.getAttribute("aria-expanded") === "true";
        prompt.setAttribute("aria-expanded", String(!expanded));
        prompt.title = expanded ? "展开任务目标" : "收起任务目标";
      });
    });
  }

  function initApprovalBanner() {
    var banner = qs("[data-approval-banner]");
    if (!banner) return;
    qsa("[data-approval]", banner).forEach(function (button) {
      button.addEventListener("click", function () {
        appendTerminalLine(button.dataset.line || button.dataset.approval, button.dataset.lineClass || "muted");
        resolveApprovalState();
        banner.remove();
      });
    });
  }

  function resolveApprovalState() {
    var state = qs(".session-state");
    if (state) {
      state.dataset.state = "running";
      state.textContent = "\u8fd0\u884c\u4e2d";
    }
    var phase = qs("[data-ts-phase]");
    if (phase) {
      phase.textContent = "\u7f16\u7801\u4e2d";
      phase.removeAttribute("data-tone");
    }
    var tagDot = qs("[data-gate-tag] .tag-dot");
    if (tagDot) tagDot.classList.remove("warning");
  }

  function initRepoImport() {
    qsa("[data-import-repo]").forEach(function (button) {
      button.addEventListener("click", function () {
        button.textContent = "已导入";
        button.disabled = true;
        button.classList.remove("primary");
        var count = qs("[data-imported-count]");
        if (count) {
          var current = parseInt(count.textContent, 10) || 0;
          count.textContent = current + 1 + " 个";
        }
      });
    });
  }

  function initRevealAndCopy() {
    qsa("[data-reveal]").forEach(function (button) {
      button.addEventListener("click", function () {
        var input = qs(button.dataset.reveal);
        if (!input) return;
        input.type = input.type === "password" ? "text" : "password";
        button.textContent = input.type === "password" ? "显示" : "隐藏";
      });
    });
    qsa("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (navigator.clipboard) navigator.clipboard.writeText(button.dataset.copy || "");
        var old = button.textContent;
        button.textContent = "已复制";
        setTimeout(function () { button.textContent = old; }, 1200);
      });
    });
  }

  function closeAccountMenus(except) {
    qsa("[data-account-menu]").forEach(function (menu) {
      if (menu === except) return;
      menu.classList.remove("is-open");
      var trigger = qs("[data-account-trigger]", menu);
      var popover = qs("[data-account-popover]", menu);
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (popover) popover.hidden = true;
    });
  }

  function initAccountMenus() {
    qsa("[data-account-menu]").forEach(function (menu) {
      var trigger = qs("[data-account-trigger]", menu);
      var popover = qs("[data-account-popover]", menu);
      if (!trigger || !popover) return;

      trigger.addEventListener("click", function (event) {
        event.stopPropagation();
        var open = trigger.getAttribute("aria-expanded") === "true";
        closeAccountMenus(menu);
        trigger.setAttribute("aria-expanded", String(!open));
        popover.hidden = open;
        menu.classList.toggle("is-open", !open);
      });

      popover.addEventListener("click", function (event) {
        if (event.target.closest("[data-menu-close]")) closeAccountMenus();
      });
    });

    document.addEventListener("click", function (event) {
      if (!event.target.closest("[data-account-menu]")) closeAccountMenus();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeAccountMenus();
    });
  }

  function initLogin() {
    qsa("[data-login-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var success = qs("[data-login-success]");
        var empty = qs("[data-login-empty]");
        if (empty) empty.hidden = true;
        if (success) success.hidden = false;
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initSegmented();
    initFilters();
    initTabs();
    initDialogs();
    initTaskForm();
    initTerminalActions();
    initSessionPrompt();
    initApprovalBanner();
    initRepoImport();
    initRevealAndCopy();
    initAccountMenus();
    initLogin();
  });
})();
