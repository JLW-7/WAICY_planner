// Axis - AI Student Planner
// This file wires up authentication, onboarding, task management, scheduling, calendar rendering, chatbot, and user data persistence.

const STORAGE_KEY = "planwise_auth_token";
const STORAGE_USER_KEY = "planwise_user";

const PRIORITY_WEIGHTS = {
  "Urgent & Important": 1,
  "Urgent, Not Important": 2,
  "Important, Not Urgent": 3,
  "Not Urgent & Not Important": 4,
};

const PRODUCTIVE_TIME_WINDOWS = {
  "Early Morning": [6, 9],
  Morning: [9, 12],
  Afternoon: [12, 17],
  Evening: [17, 21],
  "Late Night": [21, 24],
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

let state = {
  profile: null,
  tasks: [],
  rankedTasks: [],
  schedule: [], // array of {kind: 'task', taskId, start: Date ISO, end: Date ISO}
  fixedBlocks: [], // array of {kind: 'fixed', label, start, end, category}
  goals: [], // array of {id, name, color, level: 'lifetime'|'yearly'|'monthly'|'weekly'|'daily', parentId}
  reflections: [], // array of {id, type: 'daily'|'weekly'|'monthly', date, content, analysis}
  blockingRules: [], // array of {id, domain, action: 'block'|'redirect', redirectUrl}
  firstReflectionDueDate: null, // ISO date string for when first weekly reflection is due (7 days after signup)
};

// Authentication state
let authToken = null;
let currentUser = null;

// Currently edited task (if any)
let editingTaskId = null;

// Onboarding display mode: null | "personalization-only"
let onboardingMode = null;
let shouldShowOnboarding = false;

// ---------- View Management ----------

function showView(viewName) {
  const views = ['landingPage', 'authScreen', 'dashboard'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(viewName);
  if (target) target.classList.remove('hidden');
}

// ---------- Authentication & API ----------

function getAuthToken() {
  return localStorage.getItem(STORAGE_KEY);
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
    authToken = token;
  } else {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_USER_KEY);
    authToken = null;
    currentUser = null;
  }
}

function getAuthHeaders() {
  const token = getAuthToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function loadUserData() {
  try {
    const token = getAuthToken();
    if (!token) return false;

    const res = await fetch("/api/user/data", {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        setAuthToken(null);
        return false;
      }
      throw new Error("Failed to load user data");
    }

    const data = await res.json();
    state = {
      profile: data.profile || null,
      tasks: data.tasks || [],
      rankedTasks: data.rankedTasks || [],
      schedule: data.schedule || [],
      fixedBlocks: data.fixedBlocks || [],
      goals: data.goals || [],
      reflections: data.reflections || [],
      blockingRules: data.blockingRules || [],
      dailyHabits: data.dailyHabits || [],
      firstReflectionDueDate: data.firstReflectionDueDate || null,
    };
    
    // Initialize firstReflectionDueDate if it doesn't exist (for existing users)
    if (!state.firstReflectionDueDate && state.reflections && state.reflections.length === 0) {
      // Set first reflection due date to 7 days from now
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7);
      state.firstReflectionDueDate = dueDate.toISOString();
      saveUserData();
    }

    migrateProfileData();
    migrateGoalsData();
    ensureTaskIds();
    return true;
  } catch (err) {
    console.error("Error loading user data:", err);
    return false;
  }
}

async function saveUserData() {
  try {
    const token = getAuthToken();
    if (!token) {
      console.warn("No auth token, cannot save user data");
      return;
    }

    const res = await fetch("/api/user/data", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(state),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        setAuthToken(null);
        showAuthScreen();
        return;
      }
      throw new Error("Failed to save user data");
    }
  } catch (err) {
    console.error("Error saving user data:", err);
  }
}

// Legacy localStorage save (for backward compatibility during migration)
function saveState() {
  saveUserData();
}

// Legacy localStorage load (for backward compatibility during migration)
function loadState() {
  // This is now handled by loadUserData()
  return loadUserData();
}

// Migrate old profile data to new format
function migrateProfileData() {
  if (!state.profile) return;
  
  const profile = state.profile;
  let migrated = false;
  
  // Migrate procrastinator_type from old uppercase format to new lowercase format
  if (profile.procrastinator_type) {
    const oldToNew = {
      "Perfectionist": "perfectionist",
      "Deadline-driven": "deadline-driven",
      "Works better under pressure": "deadline-driven",
      "Dreamer": "lack-of-motivation",
      "Fear-based": "overwhelmed",
      "Decision-fatigue": "overwhelmed",
      "Distraction": "distraction",
      "Lack-of-motivation": "lack-of-motivation",
      "Avoidant": "avoidant",
      "Overwhelmed": "overwhelmed",
    };
    
    const oldValue = profile.procrastinator_type;
    const newValue = oldToNew[oldValue] || oldValue.toLowerCase();
    
    if (oldValue !== newValue) {
      profile.procrastinator_type = newValue;
      migrated = true;
    }
  }
  
  // Remove deprecated works_best field if it exists
  if (profile.works_best !== undefined) {
    delete profile.works_best;
    migrated = true;
  }
  
  // Save migrated data back to state
  if (migrated) {
    saveUserData();
    console.log("Profile data migrated to new format");
  }
}

// Migrate old goals data to new format
function migrateGoalsData() {
  if (!state.goals || !Array.isArray(state.goals)) return;
  
  let migrated = false;
  
  // Set level: "lifetime" on all goals that lack this property
  state.goals.forEach((goal) => {
    if (!goal.level) {
      goal.level = "lifetime";
      migrated = true;
    }
  });
  
  // Save migrated data back to state
  if (migrated) {
    saveUserData();
    console.log("Goals data migrated to new format");
  }
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function formatMinutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function todayLocalISODate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function compareBy(a, b, key) {
  if (a[key] < b[key]) return -1;
  if (a[key] > b[key]) return 1;
  return 0;
}

// ---------- DOM Helpers ----------

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function applyOnboardingModeUI() {
  const stepsToHide = ["2", "3"];
  stepsToHide.forEach((step) => {
    const stepEl = document.querySelector(`.wizard-step[data-step="${step}"]`);
    const indicatorEl = document.querySelector(
      `.wizard-step-indicator[data-step="${step}"]`,
    );
    const hidden = onboardingMode === "personalization-only";
    if (stepEl) {
      stepEl.classList.toggle("hidden", hidden);
      stepEl.style.display = hidden ? "none" : "";
    }
    if (indicatorEl) {
      indicatorEl.classList.toggle("hidden", hidden);
      indicatorEl.style.display = hidden ? "none" : "";
    }
  });
}

function setStep(step) {
  const wizard = $("#wizard");
  if (!wizard) return;
  
  // In personalization-only mode, force step 1 and hide later steps
  if (onboardingMode === "personalization-only" && step && step !== 1) {
    step = 1;
  }
  applyOnboardingModeUI();

  // Show wizard modal if step is set (during onboarding)
  if (step) {
    wizard.classList.remove("hidden");
    $all(".wizard-step").forEach((el) => {
      el.classList.toggle("active", el.dataset.step === String(step));
    });
    $all(".wizard-step-indicator").forEach((el) => {
      el.classList.toggle("active", el.dataset.step === String(step));
    });
  } else {
    // Hide wizard modal if no step (dashboard mode)
    wizard.classList.add("hidden");
  }
}

function showToast(message) {
  // Small, non-intrusive toast using alert as fallback for simplicity
  console.log("[Axis]", message);
}

// ---------- Pomodoro Timer ----------

let pomodoroTimer = null;
let pomodoroTimeLeft = 0; // in seconds
let pomodoroTotalTime = 0; // in seconds
let pomodoroInterval = null;
let currentTaskId = null;

function getTimerDurationFromProfile() {
  // Default to 25 minutes (standard Pomodoro)
  let durationMinutes = 25;
  
  if (!state.profile) {
    return durationMinutes;
  }
  
  const profile = state.profile;
  
  // First, try to parse preferred_study_method (e.g., "25-min study, 5-min break")
  if (profile.preferred_study_method) {
    const studyMatch = profile.preferred_study_method.match(/(\d+)[\s-]*(?:min|minute)/i);
    if (studyMatch) {
      const customChunk = parseInt(studyMatch[1]);
      if (customChunk >= 15 && customChunk <= 120) {
        durationMinutes = customChunk;
      }
    }
  }
  
  // If no custom duration found, use preferred_work_style
  if (durationMinutes === 25 && profile.preferred_work_style) {
    if (profile.preferred_work_style === "Short, focused bursts") {
      durationMinutes = 25; // Pomodoro-style
    } else if (profile.preferred_work_style === "Long, deep sessions") {
      durationMinutes = 60; // Longer sessions
    } else if (profile.preferred_work_style === "A mix of both") {
      durationMinutes = 40; // Middle ground
    }
  }
  
  return durationMinutes;
}

function openPomodoroTimer(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  
  currentTaskId = taskId;
  const durationMinutes = getTimerDurationFromProfile();
  pomodoroTotalTime = durationMinutes * 60;
  pomodoroTimeLeft = pomodoroTotalTime;
  
  // Update modal content
  $("#pomodoroTaskName").textContent = task.task_name;
  const catInfo = getCategoryInfo(task.task_category || 'study');
  $("#pomodoroTaskCategory").textContent = catInfo.name;
  
  // Reset timer display
  updatePomodoroDisplay();
  $("#pomodoroStatus").textContent = "Ready to start";
  $("#pomodoroStartBtn").classList.remove("hidden");
  $("#pomodoroPauseBtn").classList.add("hidden");
  
  // Show modal
  $("#pomodoroModal").classList.remove("hidden");
  
  // Stop any running timer
  if (pomodoroInterval) {
    clearInterval(pomodoroInterval);
    pomodoroInterval = null;
  }
}

function closePomodoroTimer() {
  $("#pomodoroModal").classList.add("hidden");
  if (pomodoroInterval) {
    clearInterval(pomodoroInterval);
    pomodoroInterval = null;
  }
  currentTaskId = null;
}

function updatePomodoroDisplay() {
  const minutes = Math.floor(pomodoroTimeLeft / 60);
  const seconds = pomodoroTimeLeft % 60;
  $("#pomodoroTimer").textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  
  // Update progress bar
  const progress = pomodoroTotalTime > 0 ? ((pomodoroTotalTime - pomodoroTimeLeft) / pomodoroTotalTime) * 100 : 0;
  $("#pomodoroProgressFill").style.width = `${progress}%`;
}

function startPomodoroTimer() {
  if (pomodoroInterval) return; // Already running
  
  $("#pomodoroStartBtn").classList.add("hidden");
  $("#pomodoroPauseBtn").classList.remove("hidden");
  $("#pomodoroStatus").textContent = "Focusing...";
  
  pomodoroInterval = setInterval(() => {
    pomodoroTimeLeft--;
    updatePomodoroDisplay();
    
    if (pomodoroTimeLeft <= 0) {
      clearInterval(pomodoroInterval);
      pomodoroInterval = null;
      $("#pomodoroStatus").textContent = "Time's up! Great work! 🎉";
      $("#pomodoroStartBtn").classList.remove("hidden");
      $("#pomodoroPauseBtn").classList.add("hidden");
      
      // Play notification sound (if available) or just show alert
      if (typeof Audio !== 'undefined') {
        // Try to play a simple beep using Web Audio API
        try {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();
          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);
          oscillator.frequency.value = 800;
          oscillator.type = 'sine';
          gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.5);
        } catch (e) {
          // Fallback: browser notification
          if (Notification.permission === 'granted') {
            new Notification('Pomodoro Timer', { body: 'Time\'s up! Great work! 🎉' });
          }
        }
      }
    }
  }, 1000);
}

function pausePomodoroTimer() {
  if (!pomodoroInterval) return;
  
  clearInterval(pomodoroInterval);
  pomodoroInterval = null;
  $("#pomodoroStartBtn").classList.remove("hidden");
  $("#pomodoroPauseBtn").classList.add("hidden");
  $("#pomodoroStatus").textContent = "Paused";
}

function resetPomodoroTimer() {
  if (pomodoroInterval) {
    clearInterval(pomodoroInterval);
    pomodoroInterval = null;
  }
  pomodoroTimeLeft = pomodoroTotalTime;
  updatePomodoroDisplay();
  $("#pomodoroStatus").textContent = "Ready to start";
  $("#pomodoroStartBtn").classList.remove("hidden");
  $("#pomodoroPauseBtn").classList.add("hidden");
}

function initPomodoroTimer() {
  // Remove existing listeners by cloning and replacing elements
  const pomodoroStartBtn = $("#pomodoroStartBtn");
  if (pomodoroStartBtn) {
    const newBtn = pomodoroStartBtn.cloneNode(true);
    pomodoroStartBtn.parentNode?.replaceChild(newBtn, pomodoroStartBtn);
    newBtn.addEventListener("click", startPomodoroTimer);
  }
  
  const pomodoroPauseBtn = $("#pomodoroPauseBtn");
  if (pomodoroPauseBtn) {
    const newBtn = pomodoroPauseBtn.cloneNode(true);
    pomodoroPauseBtn.parentNode?.replaceChild(newBtn, pomodoroPauseBtn);
    newBtn.addEventListener("click", pausePomodoroTimer);
  }
  
  const pomodoroResetBtn = $("#pomodoroResetBtn");
  if (pomodoroResetBtn) {
    const newBtn = pomodoroResetBtn.cloneNode(true);
    pomodoroResetBtn.parentNode?.replaceChild(newBtn, pomodoroResetBtn);
    newBtn.addEventListener("click", resetPomodoroTimer);
  }
  
  const closePomodoroBtn = $("#closePomodoroBtn");
  if (closePomodoroBtn) {
    const newBtn = closePomodoroBtn.cloneNode(true);
    closePomodoroBtn.parentNode?.replaceChild(newBtn, closePomodoroBtn);
    newBtn.addEventListener("click", closePomodoroTimer);
  }
  
  // Close on background click - use onclick to replace handler
  const pomodoroModal = $("#pomodoroModal");
  if (pomodoroModal) {
    pomodoroModal.onclick = (e) => {
      if (e.target.id === "pomodoroModal") {
        closePomodoroTimer();
      }
    };
  }
  
  // Request notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

// ---------- Authentication UI ----------

function showAuthScreen() {
  $("#authScreen")?.classList.remove("hidden");
  $("#dashboard")?.classList.add("hidden");
  $("#landingPage")?.classList.add("hidden");
}

function hideAuthScreen() {
  $("#authScreen")?.classList.add("hidden");
  $("#dashboard")?.classList.remove("hidden");
  $("#landingPage")?.classList.add("hidden");
}

function showError(elementId, message) {
  const errorEl = $(elementId);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
}

function hideError(elementId) {
  const errorEl = $(elementId);
  if (errorEl) {
    errorEl.classList.add("hidden");
  }
}

async function handleLogin(email, password) {
  try {
    hideError("#authError");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error("Failed to parse response:", parseErr);
      showError("#authError", `Server error (${res.status}). Please check if the server is running.`);
      return false;
    }

    if (!res.ok) {
      showError("#authError", data.error || `Login failed (${res.status})`);
      return false;
    }

    if (!data.token || !data.user) {
      showError("#authError", "Invalid response from server");
      return false;
    }

    setAuthToken(data.token);
    currentUser = data.user;
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(data.user));
    
    // Logins should not trigger onboarding wizard
    onboardingMode = null;
    shouldShowOnboarding = false;

    await loadUserData();
    showView('dashboard');
    // Initialize all dashboard features
    initDashboard();
    // Start periodic reflection checker
    startReflectionChecker();
    return true;
  } catch (err) {
    console.error("Login error:", err);
    if (err.message && err.message.includes("fetch")) {
      showError("#authError", "Cannot connect to server. Please make sure the server is running on port 3000.");
    } else {
      showError("#authError", "Network error. Please try again.");
    }
    return false;
  }
}

async function handleSignup(name, email, password) {
  try {
    hideError("#signupError");
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error("Failed to parse response:", parseErr);
      showError("#signupError", `Server error (${res.status}). Please check if the server is running.`);
      return false;
    }

    if (!res.ok) {
      showError("#signupError", data.error || `Signup failed (${res.status})`);
      return false;
    }

    if (!data.token || !data.user) {
      showError("#signupError", "Invalid response from server");
      return false;
    }

    setAuthToken(data.token);
    currentUser = data.user;
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(data.user));
    
    // New signups should see personalization only (no tasks/confirm steps)
    onboardingMode = "personalization-only";
    shouldShowOnboarding = true;
    applyOnboardingModeUI();

    await loadUserData();
    showView('dashboard');
    // Initialize all dashboard features
    initDashboard();
    // Show personalization-only onboarding for new users (only during signup)
    if (shouldShowOnboarding && !state.profile) {
      setStep(1);
      initOnboardingGoals();
    } else {
      startReflectionChecker();
    }
    return true;
  } catch (err) {
    console.error("Signup error:", err);
    if (err.message && err.message.includes("fetch")) {
      showError("#signupError", "Cannot connect to server. Please make sure the server is running on port 3000.");
    } else {
      showError("#signupError", "Network error. Please try again.");
    }
    return false;
  }
}

async function handleGoogleAuth() {
  // For now, show a message that Google OAuth needs to be configured
  // In production, this would integrate with Google OAuth
  alert("Google OAuth integration requires additional setup. Please use email/password for now.");
}

function handleLogout() {
  if (confirm("Are you sure you want to logout?")) {
    // Stop reflection checker
    stopReflectionChecker();
    setAuthToken(null);
    state = {
      profile: null,
      tasks: [],
      rankedTasks: [],
      schedule: [],
      fixedBlocks: [],
      goals: [],
      reflections: [],
      blockingRules: [],
      dailyHabits: [],
    };
    showView('landingPage');
  }
}

function initAuth() {
  // Auth tab switching
  $all(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.tab;
      $all(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === targetTab));
      $all(".auth-form").forEach((f) => f.classList.toggle("active", f.id === `${targetTab}Form`));
      hideError("#authError");
      hideError("#signupError");
    });
  });

  // Login form
  $("#loginFormElement")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    await handleLogin(email, password);
  });

  // Signup form
  $("#signupFormElement")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#signupName").value.trim();
    const email = $("#signupEmail").value.trim();
    const password = $("#signupPassword").value;
    if (password.length < 8) {
      showError("#signupError", "Password must be at least 8 characters");
      return;
    }
    await handleSignup(name, email, password);
  });

  // Google auth buttons
  $("#googleLoginBtn")?.addEventListener("click", handleGoogleAuth);
  $("#googleSignupBtn")?.addEventListener("click", handleGoogleAuth);

  // Logout button
  $("#logoutBtn")?.addEventListener("click", handleLogout);

  // Settings button
  $("#settingsBtn")?.addEventListener("click", () => {
    $("#settingsPanel")?.classList.remove("hidden");
    initSettings();
  });

  $("#closeSettingsBtn")?.addEventListener("click", () => {
    $("#settingsPanel")?.classList.add("hidden");
  });

  $("#settingsPanel .settings-overlay")?.addEventListener("click", () => {
    $("#settingsPanel")?.classList.add("hidden");
  });

  // Settings tabs
  $all(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.tab;
      $all(".settings-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === targetTab));
      $all(".settings-section").forEach((s) => s.classList.toggle("active", s.id === `settings${targetTab.charAt(0).toUpperCase() + targetTab.slice(1)}`));
    });
  });

  // Auth logo click to return to landing
  $("#authLogo")?.addEventListener("click", () => {
    showView('landingPage');
  });
}

function renderGoalsHierarchy() {
  const container = $("#goalsHierarchy");
  if (!container) return;

  const levels = ["lifetime", "yearly", "monthly", "weekly", "daily"];
  container.innerHTML = "";

  levels.forEach((level) => {
    const levelGoals = (state.goals || []).filter((g) => g.level === level);
    const section = document.createElement("div");
    section.className = "goals-hierarchy-level";
    section.innerHTML = `
      <h4>${level.charAt(0).toUpperCase() + level.slice(1)} Goals</h4>
      <div class="goals-hierarchy-list" data-level="${level}">
        ${levelGoals.length === 0 ? '<p class="goals-empty-hint">No goals yet</p>' : ""}
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-add-goal-level="${level}">Add ${level} goal</button>
    `;
    container.appendChild(section);

    levelGoals.forEach((goal) => {
      const goalEl = document.createElement("div");
      goalEl.className = "goals-hierarchy-item";
      goalEl.innerHTML = `
        <span style="color: ${goal.color?.text || '#000'}">${goal.name}</span>
        <button type="button" class="btn-icon-sm" data-delete-goal="${goal.id}">×</button>
      `;
      section.querySelector(`[data-level="${level}"]`).appendChild(goalEl);
    });
  });

  // Add goal handlers
  container.onclick = (e) => {
    const addBtn = e.target.closest("[data-add-goal-level]");
    if (addBtn) {
      const level = addBtn.dataset.addGoalLevel;
      const name = prompt(`Enter ${level} goal name:`);
      if (name && name.trim()) {
        addGoal(name.trim(), level);
        renderGoalsHierarchy();
      }
      return;
    }

    const deleteBtn = e.target.closest("[data-delete-goal]");
    if (deleteBtn) {
      const goalId = deleteBtn.dataset.deleteGoal;
      deleteGoal(goalId);
      renderGoalsHierarchy();
    }
  };
}

function renderBlockingRules() {
  const container = $("#blockingRulesList");
  if (!container) return;

  container.innerHTML = "";

  if (!state.blockingRules || state.blockingRules.length === 0) {
    container.innerHTML = '<p class="settings-description">No blocking rules configured yet.</p>';
    return;
  }

  state.blockingRules.forEach((rule) => {
    const ruleEl = document.createElement("div");
    ruleEl.className = "blocking-rule-item";
    ruleEl.innerHTML = `
      <div>
        <strong>${rule.domain}</strong>
        <span class="blocking-rule-action">${rule.action === "block" ? "Block" : `Redirect to ${rule.redirectUrl || ""}`}</span>
      </div>
      <button type="button" class="btn-icon-sm" data-delete-rule="${rule.id}">×</button>
    `;
    container.appendChild(ruleEl);
  });

  container.onclick = (e) => {
    const deleteBtn = e.target.closest("[data-delete-rule]");
    if (deleteBtn) {
      const ruleId = deleteBtn.dataset.deleteRule;
      state.blockingRules = state.blockingRules.filter((r) => r.id !== ruleId);
      saveUserData();
      renderBlockingRules();
    }
  };
}

// Initialize blocking rules button handler once (not in renderBlockingRules to avoid accumulation)
function initBlockingRulesButton() {
  const addBtn = $("#addBlockingRuleBtn");
  if (!addBtn) return;
  
  // Remove existing listener if any (by cloning and replacing)
  const newBtn = addBtn.cloneNode(true);
  addBtn.parentNode?.replaceChild(newBtn, addBtn);
  
  newBtn.addEventListener("click", () => {
    const domain = prompt("Enter domain to block (e.g., youtube.com):");
    if (!domain) return;

    const action = confirm("Block completely? (Cancel = Redirect)") ? "block" : "redirect";
    let redirectUrl = "";
    if (action === "redirect") {
      redirectUrl = prompt("Enter redirect URL (e.g., youtube.com/feed/subscriptions):") || "";
    }

    const rule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      domain: domain.trim(),
      action,
      redirectUrl,
    };

    if (!state.blockingRules) state.blockingRules = [];
    state.blockingRules.push(rule);
    saveUserData();
    renderBlockingRules();
  });
}

function renderReflectionsList() {
  const container = $("#reflectionsList");
  if (!container) return;

  container.innerHTML = "";

  if (!state.reflections || state.reflections.length === 0) {
    container.innerHTML = '<p class="settings-description">No reflections yet.</p>';
    return;
  }

  const sorted = [...state.reflections].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach((reflection) => {
    const refEl = document.createElement("div");
    refEl.className = "reflection-item";
    refEl.innerHTML = `
      <div>
        <strong>${reflection.type.charAt(0).toUpperCase() + reflection.type.slice(1)} Reflection</strong>
        <span class="reflection-date">${new Date(reflection.date).toLocaleDateString()}</span>
      </div>
      <p class="reflection-preview">${reflection.content.substring(0, 100)}${reflection.content.length > 100 ? "..." : ""}</p>
      ${reflection.analysis ? `<div class="reflection-analysis">AI Analysis: ${reflection.analysis}</div>` : ""}
    `;
    container.appendChild(refEl);
  });
}

// Initialize profile edit form handler once (not in initSettings to avoid accumulation)
function initProfileEditForm() {
  const form = $("#profileEditForm");
  if (!form) return;
  
  // Remove existing listener if any (by cloning and replacing)
  const newForm = form.cloneNode(true);
  form.parentNode?.replaceChild(newForm, form);
  
  newForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#profileEditName").value.trim();
    if (!name) {
      alert("Name is required");
      return;
    }
    // Update user name (would need backend endpoint for this)
    currentUser.name = name;
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(currentUser));
    alert("Profile updated");
  });
}

function initSettings() {
  // Load current user info
  if (currentUser) {
    $("#profileEditName").value = currentUser.name || "";
    $("#profileEditEmail").value = currentUser.email || "";
  }

  // Initialize profile edit form (only once)
  initProfileEditForm();

  // Render goals hierarchy
  renderGoalsHierarchy();

  // Render blocking rules
  renderBlockingRules();
  
  // Initialize blocking rules button (only once)
  initBlockingRulesButton();

  // Render reflections
  renderReflectionsList();
}

// ---------- Initialization ----------

function initDashboard() {
  initWeeklyScheduleInputs();
  initWeekendScheduleInputs();
  initDeadlineTimeOptions();
  initProfileInteractions();
  initTaskForm();
  initWizardButtons();
  initChatbot();
  initCalendarViewToggle();
  initGoals();
  initDailyHabits();
  initPomodoroTimer();
  restoreFromState();
}

function initLandingPage() {
  // Landing page button handlers
  $('#landingGetStartedBtn').addEventListener('click', () => {
    showView('authScreen');
    // Switch to signup tab
    $('.auth-tab[data-tab="signup"]').click();
  });
  
  $('#landingLoginBtn').addEventListener('click', () => {
    showView('authScreen');
    // Ensure login tab is active
    $('.auth-tab[data-tab="login"]').click();
  });
  
  $('#heroGetStartedBtn').addEventListener('click', () => {
    showView('authScreen');
    $('.auth-tab[data-tab="signup"]').click();
  });
  
  $('#ctaGetStartedBtn').addEventListener('click', () => {
    showView('authScreen');
    $('.auth-tab[data-tab="signup"]').click();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Always show landing page first
  showView('landingPage');

  initAuth();
  initLandingPage();
});

function initWeeklyScheduleInputs() {
  const container = $("#weekly_schedule");
  if (!container) return;
  container.innerHTML = "";
  ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((day) => {
    const wrapper = document.createElement("div");
    wrapper.className = "weekly-day";
    wrapper.dataset.day = day;
    wrapper.innerHTML = `
      <div class="weekly-day-header">${day}</div>
      <div class="weekly-commitments" data-day="${day}"></div>
      <button type="button" class="btn-add-commitment" data-day="${day}">+ Add commitment</button>
    `;
    container.appendChild(wrapper);
    
    // Add commitment button handler
    wrapper.querySelector(".btn-add-commitment").addEventListener("click", () => {
      addCommitmentRow(day);
    });
  });
}

function initWeekendScheduleInputs() {
  const container = $("#weekend_schedule");
  if (!container) return;
  container.innerHTML = "";
  ["Saturday", "Sunday"].forEach((day) => {
    const wrapper = document.createElement("div");
    wrapper.className = "weekend-day";
    wrapper.dataset.day = day;
    wrapper.innerHTML = `
      <div class="weekly-day-header">${day}</div>
      <div class="weekly-commitments" data-day="${day}"></div>
      <button type="button" class="btn-add-commitment" data-day="${day}">+ Add activity</button>
    `;
    container.appendChild(wrapper);
    
    // Add activity button handler
    wrapper.querySelector(".btn-add-commitment").addEventListener("click", () => {
      addCommitmentRow(day, true);
    });
  });
}

function addCommitmentRow(day, isWeekend = false) {
  const selector = isWeekend 
    ? `.weekly-commitments[data-day="${day}"]` 
    : `.weekly-commitments[data-day="${day}"]`;
  const commitmentsContainer = $(selector);
  if (!commitmentsContainer) return;
  
  const commitmentId = `commit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const row = document.createElement("div");
  row.className = "commitment-row";
  row.dataset.commitmentId = commitmentId;
  row.innerHTML = `
    <input type="text" class="commitment-name" placeholder="Name (e.g., Soccer Practice)" required />
    <input type="text" class="commitment-time" placeholder="Time range (e.g., 10:00-12:00)" required />
    <input type="text" class="commitment-desc" placeholder="Description (optional)" />
    <div class="commitment-row-actions">
      <button type="button" class="btn-remove-commitment">Remove</button>
    </div>
  `;
  commitmentsContainer.appendChild(row);
  
  row.querySelector(".btn-remove-commitment").addEventListener("click", () => {
    row.remove();
  });
}

function initDeadlineTimeOptions() {
  const select = $("#task_deadline_time");
  if (!select) return;
  select.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      select.appendChild(opt);
    }
  }
  select.value = "23:59";
}

function initProfileInteractions() {
  // Procrastinator yes/no buttons - remove existing listeners by cloning
  const procrastGroup = $("#is_procrastinator_group");
  if (procrastGroup && !procrastGroup.dataset.initialized) {
    procrastGroup.dataset.initialized = "true";
    procrastGroup.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      const val = e.target.dataset.value;
      $("#is_procrastinator").value = val;
      $all("#is_procrastinator_group button").forEach((btn) =>
        btn.classList.toggle("selected", btn === e.target),
      );
      $("#procrastinator_yes").classList.toggle("hidden", val !== "yes");
      $("#procrastinator_no").classList.toggle("hidden", val !== "no");
    });
  }

  const buttonGroups = [
    "#has_trouble_finishing_group",
  ];

  buttonGroups.forEach((selector) => {
    const group = $(selector);
    if (!group || group.dataset.initialized) return;
    group.dataset.initialized = "true";
    group.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      const hidden = group.querySelector("input[type=hidden]");
      if (hidden) {
        hidden.value = e.target.dataset.value;
      }
      group
        .querySelectorAll("button")
        .forEach((btn) => btn.classList.toggle("selected", btn === e.target));
    });
  });

  // Save profile button - ensure it's enabled and has event listener
  const saveProfileBtn = $("#saveProfileBtn");
  if (saveProfileBtn) {
    // Ensure button is enabled
    saveProfileBtn.disabled = false;
    saveProfileBtn.removeAttribute("disabled");
    
    // Remove old listener if exists (clone to remove all listeners)
    const newBtn = saveProfileBtn.cloneNode(true);
    saveProfileBtn.parentNode?.replaceChild(newBtn, saveProfileBtn);
    
    // Attach fresh event listener
    newBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const profile = readProfileFromForm();
      if (!profile) return;
      state.profile = profile;
      // Read goals from onboarding form
      readGoalsFromOnboardingForm();
      
      // Set first reflection due date for new users (7 days from now)
      if (!state.firstReflectionDueDate) {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 7);
        state.firstReflectionDueDate = dueDate.toISOString();
      }
      
      saveUserData();
      showToast("Profile saved.");
      // Clear personalization-only mode to allow navigation to goal canvas
      onboardingMode = null;
      applyOnboardingModeUI();
      // Go to goal canvas after profile is saved
      setStep(2);
      // Initialize canvas after a brief delay to ensure DOM is ready
      setTimeout(() => {
        initGoalCanvas();
      }, 100);
    });
  }
}

function initOnboardingGoals() {
  const container = $("#onboardingGoalsHierarchy");
  if (!container) return;
  
  // Render goals hierarchy similar to settings, but for onboarding
  const levels = ["lifetime", "yearly", "monthly", "weekly", "daily"];
  container.innerHTML = "";
  
  levels.forEach((level) => {
    const levelGoals = (state.goals || []).filter((g) => g.level === level);
    const section = document.createElement("div");
    section.className = "goals-hierarchy-level";
    section.innerHTML = `
      <h4>${level.charAt(0).toUpperCase() + level.slice(1)} Goals</h4>
      <div class="goals-hierarchy-list" data-level="${level}">
        ${levelGoals.length === 0 ? '<p class="goals-empty-hint">No goals yet</p>' : ""}
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-add-goal-level="${level}">Add ${level} goal</button>
    `;
    container.appendChild(section);
    
    levelGoals.forEach((goal) => {
      const goalEl = document.createElement("div");
      goalEl.className = "goals-hierarchy-item";
      goalEl.innerHTML = `
        <span style="color: ${goal.color?.text || '#000'}">${goal.name}</span>
        <button type="button" class="btn-icon-sm" data-delete-goal="${goal.id}">×</button>
      `;
      section.querySelector(`[data-level="${level}"]`).appendChild(goalEl);
    });
  });
  
  // Add goal handlers
  container.onclick = (e) => {
    const addBtn = e.target.closest("[data-add-goal-level]");
    if (addBtn) {
      const level = addBtn.dataset.addGoalLevel;
      getGoalNameSuggestion(level).then((suggestion) => {
        const name = prompt(`Enter ${level} goal name:`, suggestion || "");
        if (name && name.trim()) {
          addGoal(name.trim(), level);
          initOnboardingGoals(); // Re-render
        }
      });
      return;
    }
    
    const deleteBtn = e.target.closest("[data-delete-goal]");
    if (deleteBtn) {
      const goalId = deleteBtn.dataset.deleteGoal;
      deleteGoal(goalId);
      initOnboardingGoals(); // Re-render
    }
  };
}

function readGoalsFromOnboardingForm() {
  // Goals are already in state.goals from addGoal() calls
  // This function is just a placeholder for consistency
  // The goals are saved when saveUserData() is called
}

function readProfileFromForm() {
  const user_name = $("#user_name").value.trim();
  const user_age_group = $("#user_age_group").value;
  if (!user_name || !user_age_group) {
    alert("Please fill in your name and age group.");
    return null;
  }

  const weekly_schedule = {};
  ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((day) => {
    const commitments = [];
    $all(`.weekly-commitments[data-day="${day}"] .commitment-row`).forEach((row) => {
      const name = row.querySelector(".commitment-name").value.trim();
      const time = row.querySelector(".commitment-time").value.trim();
      const desc = row.querySelector(".commitment-desc").value.trim();
      if (name && time) {
        commitments.push({
          name,
          time,
          description: desc || null,
        });
      }
    });
    weekly_schedule[day] = commitments;
  });

  const weekend_schedule = {};
  ["Saturday", "Sunday"].forEach((day) => {
    const activities = [];
    $all(`.weekly-commitments[data-day="${day}"] .commitment-row`).forEach((row) => {
      const name = row.querySelector(".commitment-name").value.trim();
      const time = row.querySelector(".commitment-time").value.trim();
      const desc = row.querySelector(".commitment-desc").value.trim();
      if (name && time) {
        activities.push({
          name,
          time,
          description: desc || null,
        });
      }
    });
    weekend_schedule[day] = activities;
  });

  const profile = {
    user_name,
    user_age_group,
    weekly_schedule,
    weekend_schedule,
    sleep_weekdays: $("#sleep_weekdays").value.trim(),
    sleep_weekends: $("#sleep_weekends").value.trim(),
    break_times: $("#break_times").value.trim(),
    is_procrastinator: $("#is_procrastinator").value || null,
    procrastinator_type: $("#procrastinator_type").value || null,
    has_trouble_finishing: $("#has_trouble_finishing").value || null,
    preferred_work_style: $("#preferred_work_style").value || null,
    most_productive_time: $("#most_productive_time").value || null,
    preferred_study_method: $("#preferred_study_method").value.trim(),
    weekly_personal_time: parseFloat($("#weekly_personal_time").value || "0"),
    weekly_review_hours: parseFloat($("#weekly_review_hours").value || "0"),
  };
  return profile;
}

function restoreProfileToForm() {
  if (!state.profile) return;
  const p = state.profile;
  $("#user_name").value = p.user_name || "";
  $("#user_age_group").value = p.user_age_group || "";

  // Restore weekly schedule commitments
  ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((day) => {
    const commitments = p.weekly_schedule?.[day];
    const commitmentsContainer = $(`.weekly-commitments[data-day="${day}"]`);
    if (!commitmentsContainer) return;
    
    // Clear existing
    commitmentsContainer.innerHTML = "";
    
    // If old format (string), convert to array format
    if (typeof commitments === "string" && commitments.trim()) {
      // Legacy: single time range string
      const row = document.createElement("div");
      row.className = "commitment-row";
      row.dataset.commitmentId = `legacy_${day}`;
      row.innerHTML = `
        <input type="text" class="commitment-name" placeholder="Name (e.g., Math Class)" value="Fixed commitment" />
        <input type="text" class="commitment-time" placeholder="Time range (e.g., 09:00-15:00)" value="${commitments}" />
        <input type="text" class="commitment-desc" placeholder="Description (optional)" />
        <div class="commitment-row-actions">
          <button type="button" class="btn-remove-commitment">Remove</button>
        </div>
      `;
      commitmentsContainer.appendChild(row);
      row.querySelector(".btn-remove-commitment").addEventListener("click", () => {
        row.remove();
      });
    } else if (Array.isArray(commitments)) {
      // New format: array of {name, time, description}
      commitments.forEach((commitment) => {
        const row = document.createElement("div");
        row.className = "commitment-row";
        row.dataset.commitmentId = `commit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        row.innerHTML = `
          <input type="text" class="commitment-name" placeholder="Name (e.g., Math Class)" value="${commitment.name || ""}" />
          <input type="text" class="commitment-time" placeholder="Time range (e.g., 09:00-15:00)" value="${commitment.time || ""}" />
          <input type="text" class="commitment-desc" placeholder="Description (optional)" value="${commitment.description || ""}" />
          <div class="commitment-row-actions">
            <button type="button" class="btn-remove-commitment">Remove</button>
          </div>
        `;
        commitmentsContainer.appendChild(row);
        row.querySelector(".btn-remove-commitment").addEventListener("click", () => {
          row.remove();
        });
      });
    }
  });

  $("#weekend_schedule").value = p.weekend_schedule || "";
  $("#sleep_weekdays").value = p.sleep_weekdays || "";
  $("#sleep_weekends").value = p.sleep_weekends || "";
  $("#break_times").value = p.break_times || "";

  if (p.is_procrastinator) {
    $("#is_procrastinator").value = p.is_procrastinator;
    const group = $("#is_procrastinator_group");
    group
      ?.querySelectorAll("button")
      .forEach((btn) => btn.classList.toggle("selected", btn.dataset.value === p.is_procrastinator));
    $("#procrastinator_yes").classList.toggle("hidden", p.is_procrastinator !== "yes");
    $("#procrastinator_no").classList.toggle("hidden", p.is_procrastinator !== "no");
  }

  if (p.procrastinator_type) $("#procrastinator_type").value = p.procrastinator_type;
  if (p.has_trouble_finishing) {
    $("#has_trouble_finishing").value = p.has_trouble_finishing;
    const group = $("#has_trouble_finishing_group");
    group
      ?.querySelectorAll("button")
      .forEach((btn) =>
        btn.classList.toggle("selected", btn.dataset.value === p.has_trouble_finishing),
      );
  }
  if (p.preferred_work_style) $("#preferred_work_style").value = p.preferred_work_style;
  if (p.most_productive_time) $("#most_productive_time").value = p.most_productive_time;
  $("#preferred_study_method").value = p.preferred_study_method || "";
  $("#weekly_personal_time").value = p.weekly_personal_time ?? "";
  $("#weekly_review_hours").value = p.weekly_review_hours ?? "";
}

function initTaskForm() {
  // Remove existing listeners by cloning and replacing elements
  const priorityGroup = $("#task_priority_group");
  if (priorityGroup) {
    const newPriorityGroup = priorityGroup.cloneNode(true);
    priorityGroup.parentNode?.replaceChild(newPriorityGroup, priorityGroup);
    newPriorityGroup.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      const val = e.target.dataset.value;
      $("#task_priority").value = val;
      newPriorityGroup
        .querySelectorAll("button")
        .forEach((btn) => btn.classList.toggle("selected", btn === e.target));
    });
  }

  const taskForm = $("#taskForm");
  if (taskForm) {
    const newTaskForm = taskForm.cloneNode(true);
    taskForm.parentNode?.replaceChild(newTaskForm, taskForm);
    newTaskForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const task = readTaskFromForm();
      if (!task) return;

      if (editingTaskId) {
        // Update existing task
        const idx = state.tasks.findIndex((t) => t.id === editingTaskId);
        if (idx !== -1) {
          state.tasks[idx] = { ...state.tasks[idx], ...task, id: editingTaskId };
        }
        editingTaskId = null;
        const submitBtn = newTaskForm.querySelector("button[type=submit]");
        if (submitBtn) submitBtn.textContent = "Add task to list";
      } else {
        // Create new task
        const newTask = {
          ...task,
          id: `task_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          completed: false,
        };
        state.tasks.push(newTask);
      }

      saveUserData();
      renderTasks();
      renderTaskSummary();
      newTaskForm.reset();
      $("#task_priority").value = "";
      // Query by ID again since priorityGroup was replaced
      $("#task_priority_group")?.querySelectorAll("button").forEach((btn) => btn.classList.remove("selected"));
      $("#planTasksBtn").disabled = state.tasks.length === 0;
      
      // Auto-generate schedule after task change
      if (state.tasks.length > 0 && state.profile) {
        generateSchedule();
      }
    });
  }

  const planTasksBtn = $("#planTasksBtn");
  if (planTasksBtn) {
    const newPlanBtn = planTasksBtn.cloneNode(true);
    planTasksBtn.parentNode?.replaceChild(newPlanBtn, planTasksBtn);
    newPlanBtn.addEventListener("click", () => {
      if (onboardingMode === "personalization-only") {
        return; // Block navigation to task/confirm steps during signup personalization
      }
      rankTasks();
      renderRankedPreview();
      setStep(3);
    });
  }

  // Initialize task editor modal
  initTaskEditorModal();
}

function initTaskEditorModal() {
  // Initialize deadline time options for modal
  const modalDeadlineTime = $("#taskEditor_deadline_time");
  if (modalDeadlineTime) {
    modalDeadlineTime.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        modalDeadlineTime.appendChild(opt);
      }
    }
    modalDeadlineTime.value = "23:59";
  }

  // Add Task button handler
  const addTaskBtn = $("#addTaskBtn");
  if (addTaskBtn) {
    const newAddTaskBtn = addTaskBtn.cloneNode(true);
    addTaskBtn.parentNode?.replaceChild(newAddTaskBtn, addTaskBtn);
    newAddTaskBtn.addEventListener("click", () => {
      openTaskEditor();
    });
  }

  // Close modal handlers
  const closeBtn = $("#closeTaskEditorBtn");
  const cancelBtn = $("#cancelTaskEditorBtn");
  const modal = $("#taskEditorModal");
  const overlay = modal?.querySelector(".modal-overlay");

  if (closeBtn) {
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode?.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener("click", closeTaskEditor);
  }

  if (cancelBtn) {
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode?.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.addEventListener("click", closeTaskEditor);
  }

  if (overlay) {
    overlay.addEventListener("click", closeTaskEditor);
  }

  // Form submission handler and priority button delegation
  const taskEditorForm = $("#taskEditorForm");
  if (taskEditorForm) {
    const newForm = taskEditorForm.cloneNode(true);
    taskEditorForm.parentNode?.replaceChild(newForm, taskEditorForm);
    
    // Use event delegation for priority buttons (works even after form is cloned)
    newForm.addEventListener("click", (e) => {
      // Check if clicked element is a priority button
      const priorityBtn = e.target.closest("#taskEditor_priority_group button");
      if (priorityBtn) {
        e.preventDefault();
        const val = priorityBtn.dataset.value;
        const hiddenInput = $("#taskEditor_priority");
        if (hiddenInput) {
          hiddenInput.value = val;
        }
        // Update button selected states
        const priorityGroup = $("#taskEditor_priority_group");
        if (priorityGroup) {
          priorityGroup
            .querySelectorAll("button")
            .forEach((btn) => btn.classList.toggle("selected", btn === priorityBtn));
        }
      }
    });
    
    newForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const task = readTaskFromEditorForm();
      if (!task) return;

      if (editingTaskId) {
        // Update existing task
        const idx = state.tasks.findIndex((t) => t.id === editingTaskId);
        if (idx !== -1) {
          state.tasks[idx] = { ...state.tasks[idx], ...task, id: editingTaskId };
        }
        editingTaskId = null;
      } else {
        // Create new task
        const newTask = {
          ...task,
          id: `task_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          completed: false,
        };
        state.tasks.push(newTask);
      }

      saveUserData();
      renderTasks();
      renderTaskSummary();
      closeTaskEditor();
      
      // Auto-generate schedule after task change
      if (state.tasks.length > 0 && state.profile) {
        generateSchedule();
      } else {
        // Clear schedule if no tasks
        state.schedule = [];
        renderSchedule();
      }
      
      // Auto-generate schedule after task change
      if (state.tasks.length > 0 && state.profile) {
        generateSchedule();
      }
    });
  }
}

function openTaskEditor(taskId = null) {
  editingTaskId = taskId;
  const modal = $("#taskEditorModal");
  const form = $("#taskEditorForm");
  const title = $("#taskEditorTitle");

  if (!modal || !form) return;

  if (taskId) {
    // Editing existing task
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    $("#taskEditor_name").value = task.task_name || "";
    $("#taskEditor_deadline").value = task.task_deadline || "";
    $("#taskEditor_deadline_time").value = task.task_deadline_time || "23:59";
    $("#taskEditor_duration").value = task.task_duration_hours || "";
    $("#taskEditor_computer_required").checked = !!task.computer_required;
    $("#taskEditor_priority").value = task.task_priority || "";
    $("#taskEditor_category").value = task.task_category || "study";

    // Highlight priority button
    const priorityGroup = $("#taskEditor_priority_group");
    priorityGroup
      ?.querySelectorAll("button")
      .forEach((btn) => btn.classList.toggle("selected", btn.dataset.value === task.task_priority));

    if (title) title.textContent = "Edit Task";
    const submitBtn = form.querySelector("button[type=submit]");
    if (submitBtn) submitBtn.textContent = "Save Changes";
  } else {
    // Adding new task
    form.reset();
    $("#taskEditor_priority").value = "";
    $("#taskEditor_deadline_time").value = "23:59";
    $("#taskEditor_priority_group")?.querySelectorAll("button").forEach((btn) => btn.classList.remove("selected"));

    if (title) title.textContent = "Add Task";
    const submitBtn = form.querySelector("button[type=submit]");
    if (submitBtn) submitBtn.textContent = "Add Task";
  }

  modal.classList.remove("hidden");
}

function closeTaskEditor() {
  const modal = $("#taskEditorModal");
  if (modal) {
    modal.classList.add("hidden");
  }
  editingTaskId = null;
}

function readTaskFromEditorForm() {
  const name = $("#taskEditor_name")?.value.trim();
  const priority = $("#taskEditor_priority")?.value;
  const category = $("#taskEditor_category")?.value;
  const deadlineDate = $("#taskEditor_deadline")?.value;
  const deadlineTime = $("#taskEditor_deadline_time")?.value || "23:59";
  const durationHours = parseFloat($("#taskEditor_duration")?.value || "0");
  const computer_required = $("#taskEditor_computer_required")?.checked;

  if (!name || !priority || !category || !deadlineDate || !durationHours) {
    alert("Please fill in task name, priority, category, deadline, and duration.");
    return null;
  }

  const task = {
    task_name: name,
    task_priority: priority,
    task_category: category,
    task_deadline: deadlineDate,
    task_deadline_time: deadlineTime,
    task_duration_hours: durationHours,
    computer_required,
  };
  return task;
}

function readTaskFromForm() {
  const name = $("#task_name").value.trim();
  const priority = $("#task_priority").value;
  const category = $("#task_category").value;
  const deadlineDate = $("#task_deadline").value;
  const deadlineTime = $("#task_deadline_time").value || "23:59";
  const durationHours = parseFloat($("#task_duration").value || "0");
  const computer_required = $("#computer_required").checked;
  if (!name || !priority || !category || !deadlineDate || !durationHours) {
    alert("Please fill in task name, priority, category, deadline, and duration.");
    return null;
  }
  const task = {
    // id will be assigned on create; preserved on edit
    task_name: name,
    task_priority: priority,
    task_category: category,
    task_deadline: deadlineDate,
    task_deadline_time: deadlineTime,
    task_duration_hours: durationHours,
    computer_required,
  };
  return task;
}

// ---------- Goals Management ----------

function initGoals() {
  // Goals are now managed in Settings, but allow quick add from dashboard
  const addGoalBtn = $("#addGoalBtn");
  if (addGoalBtn) {
    const newBtn = addGoalBtn.cloneNode(true);
    addGoalBtn.parentNode?.replaceChild(newBtn, addGoalBtn);
    newBtn.addEventListener("click", async () => {
      const levelInput = prompt(
        'Goal level? Choose: lifetime, yearly, monthly, weekly, daily.\nLeave blank for "lifetime".',
      );
      const normalized =
        (levelInput || "lifetime").trim().toLowerCase() || "lifetime";
      const allowed = ["lifetime", "yearly", "monthly", "weekly", "daily"];
      const finalLevel = allowed.includes(normalized) ? normalized : "lifetime";

      const placeholder = await getGoalNameSuggestion(finalLevel);
      const name = prompt(
        `Add a ${finalLevel} goal:`,
        placeholder || "",
      );
      if (!name || !name.trim()) return;
      addGoal(name.trim(), finalLevel);
    });
  }

  renderGoals();
  updateCategoryDropdown();
}

function addGoal(name, level = "lifetime") {
  if (!state.goals) {
    state.goals = [];
  }
  
  // Check if goal already exists at this level
  const existing = state.goals.find(g => g.name.toLowerCase() === name.toLowerCase() && g.level === level);
  if (existing) {
    alert("A goal with this name already exists at this level.");
    return;
  }
  
  // Generate a color for the goal (cycle through a palette)
  const goalColors = [
    { bg: "rgba(139, 92, 246, 0.15)", border: "rgba(139, 92, 246, 0.3)", text: "#7c3aed" }, // Purple
    { bg: "rgba(14, 165, 233, 0.15)", border: "rgba(14, 165, 233, 0.3)", text: "#0284c7" }, // Sky blue
    { bg: "rgba(236, 72, 153, 0.15)", border: "rgba(236, 72, 153, 0.3)", text: "#db2777" }, // Pink
    { bg: "rgba(34, 197, 94, 0.15)", border: "rgba(34, 197, 94, 0.3)", text: "#16a34a" }, // Green
    { bg: "rgba(251, 146, 60, 0.15)", border: "rgba(251, 146, 60, 0.3)", text: "#ea580c" }, // Orange
    { bg: "rgba(168, 85, 247, 0.15)", border: "rgba(168, 85, 247, 0.3)", text: "#7c3aed" }, // Violet
  ];
  
  const colorIndex = state.goals.length % goalColors.length;
  const color = goalColors[colorIndex];
  
  const goal = {
    id: `goal_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name: name,
    color: color,
    level: level,
    parentId: null, // Can be set later for hierarchy
  };
  
  state.goals.push(goal);
  saveUserData();
  renderGoals();
  updateCategoryDropdown();
  
  // Generate AI breakdown for lifetime and yearly goals
  if (level === "lifetime" || level === "yearly") {
    generateGoalBreakdown(goal, { showToUser: true });
  }
}

function deleteGoal(goalId) {
  if (!confirm("Are you sure you want to delete this goal? Tasks using this category will be reassigned to 'Study'.")) {
    return;
  }
  
  const goal = state.goals.find(g => g.id === goalId);
  if (!goal) return;
  
  // Reassign tasks with this goal category to "study"
  state.tasks.forEach(task => {
    if (task.task_category === goal.name.toLowerCase().replace(/\s+/g, "-")) {
      task.task_category = "study";
    }
  });
  
  // Remove goal
  state.goals = state.goals.filter(g => g.id !== goalId);
  saveUserData();
  renderGoals();
  updateCategoryDropdown();
  renderTasks();
  renderTaskSummary();
  renderSchedule();
}

async function renderGoals() {
  const container = $("#goalsList");
  if (!container) return;
  
  container.innerHTML = "";
  
  if (!state.goals || state.goals.length === 0) {
    container.innerHTML = '<div class="goals-empty">No goals yet. Add goals in Settings.</div>';
    return;
  }
  
  const levels = ["lifetime", "yearly", "monthly", "weekly", "daily"];
  const levelLabels = {
    lifetime: "Lifetime",
    yearly: "Yearly",
    monthly: "Monthly",
    weekly: "Weekly",
    daily: "Daily"
  };
  
  levels.forEach(level => {
    const levelGoals = state.goals.filter(g => g.level === level);
    if (levelGoals.length === 0) return;
    
    const levelSection = document.createElement("div");
    levelSection.className = "goals-level-section";
    
    const levelHeader = document.createElement("div");
    levelHeader.className = "goals-level-header";
    levelHeader.textContent = levelLabels[level];
    levelSection.appendChild(levelHeader);
    
    levelGoals.forEach(goal => {
      const goalItem = document.createElement("div");
      goalItem.className = "goal-item";
      goalItem.style.borderLeftColor = goal.color?.border || goal.color?.text || "#22c55e";
      
      const goalContent = document.createElement("div");
      goalContent.className = "goal-content";
      
      const goalName = document.createElement("span");
      goalName.className = "goal-name";
      goalName.style.color = goal.color?.text || "#1a1a1a";
      goalName.textContent = goal.name;
      goalContent.appendChild(goalName);
      
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "goal-delete-btn";
      deleteBtn.dataset.goalId = goal.id;
      deleteBtn.title = "Delete goal";
      deleteBtn.textContent = "×";
      
      goalItem.appendChild(goalContent);
      goalItem.appendChild(deleteBtn);
      levelSection.appendChild(goalItem);
    });
    
    container.appendChild(levelSection);
  });
  
  // Handle delete button clicks
  container.onclick = (e) => {
    const deleteBtn = e.target.closest(".goal-delete-btn");
    if (deleteBtn) {
      const goalId = deleteBtn.dataset.goalId;
      if (goalId) {
        deleteGoal(goalId);
      }
      e.stopPropagation();
    }
  };
}

async function generateGoalBreakdown(goal, options = {}) {
  const { showToUser = false } = options;
  // Only generate breakdowns for lifetime and yearly goals
  if (goal.level !== "lifetime" && goal.level !== "yearly") {
    return;
  }
  
  // Check if we already have a breakdown
  if (goal.aiBreakdown) {
    return;
  }
  
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Break down this ${goal.level} goal into smaller actionable steps. For example, if the goal is "read 50 books per year", suggest: "~4 books per month, ~1 book per week, ~20-30 pages per day". Keep it concise (one line, 2-3 breakdowns max).\n\nGoal: ${goal.name}`,
        context: `User profile: ${JSON.stringify(state.profile || {})}`,
      }),
    });
    
    if (res.ok) {
      const data = await res.json();
      const breakdown = data.reply || "";
      
      // Update goal with breakdown
      const goalIndex = state.goals.findIndex(g => g.id === goal.id);
      if (goalIndex !== -1) {
        state.goals[goalIndex].aiBreakdown = breakdown;
        saveUserData();
        // Optionally show to user during add flow
        if (showToUser && breakdown) {
          alert(`AI suggestion:\n${breakdown}`);
        }
      }
    }
  } catch (err) {
    console.error("Error generating goal breakdown:", err);
  }
}

async function getGoalNameSuggestion(level = "lifetime") {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Suggest a concise ${level} goal the user could set. Just return the goal text, no quotes, under 60 characters.`,
        context: `Level: ${level}`,
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (typeof data.reply === "string") {
      return data.reply.trim();
    }
    return "";
  } catch (err) {
    console.error("Error getting goal suggestion:", err);
    return "";
  }
}

function updateCategoryDropdown() {
  const select = $("#task_category");
  if (!select) return;
  
  // Save current value
  const currentValue = select.value;
  
  // Clear and rebuild options
  select.innerHTML = `
    <option value="">Select...</option>
    <option value="study">Study</option>
    <option value="project">Project</option>
    <option value="chores">Chores</option>
    <option value="personal">Personal</option>
    <option value="social">Social</option>
  `;
  
  // Add goal categories
  if (state.goals && state.goals.length > 0) {
    state.goals.forEach(goal => {
      const option = document.createElement("option");
      const goalValue = goal.name.toLowerCase().replace(/\s+/g, "-");
      option.value = goalValue;
      option.textContent = goal.name;
      select.appendChild(option);
    });
  }
  
  // Restore previous value if it still exists
  if (currentValue) {
    select.value = currentValue;
  }
}

// Get category display name and style
function getCategoryInfo(categoryValue) {
  if (!categoryValue) return { name: "Study", isGoal: false };
  
  // Check if it's a goal category
  if (state.goals) {
    const goal = state.goals.find(g => 
      g.name.toLowerCase().replace(/\s+/g, "-") === categoryValue
    );
    if (goal) {
      return { name: goal.name, isGoal: true, color: goal.color };
    }
  }
  
  // Standard categories
  const standardCategories = {
    "study": "Study",
    "project": "Project",
    "chores": "Chores",
    "personal": "Personal",
    "social": "Social",
  };
  
  return { 
    name: standardCategories[categoryValue] || categoryValue, 
    isGoal: false 
  };
}

// ---------- Goal Canvas System ----------

let goalCanvasNodes = []; // Array of {id, text, level, x, y, parentId, isGhost}
let selectedNodeId = null;
// Removed draggingNodeId and dragOffset - no longer needed with list structure

const GOAL_LEVELS = ["lifetime", "yearly", "seasonal", "monthly", "weekly", "daily"];
const LEVEL_LABELS = {
  lifetime: "Lifetime",
  yearly: "Yearly",
  seasonal: "Seasonal",
  monthly: "Monthly",
  weekly: "Weekly",
  daily: "Daily"
};

function initGoalCanvas() {
  const canvas = $("#goalCanvas");
  if (!canvas) {
    console.error("Goal canvas element not found");
    return;
  }
  
  // Ensure canvas is visible
  const step2 = document.querySelector(".wizard-step[data-step='2']");
  if (step2 && !step2.classList.contains("active")) {
    console.error("Goal canvas step is not active");
    return;
  }
  
  // Initialize canvas with sections
  renderGoalCanvas();
  
  // Approve all ghosts button - ensure it exists and has event listener
  let approveAllBtn = $("#approveAllGhostsBtn");
  if (!approveAllBtn) {
    // Create button if it doesn't exist
    approveAllBtn = document.createElement("button");
    approveAllBtn.id = "approveAllGhostsBtn";
    approveAllBtn.className = "btn-approve-all-ghosts hidden";
    approveAllBtn.textContent = "Approve All AI Suggestions";
    canvas.appendChild(approveAllBtn);
  }
  
  // Remove old listeners and add fresh one
  const newBtn = approveAllBtn.cloneNode(true);
  approveAllBtn.parentNode?.replaceChild(newBtn, approveAllBtn);
  newBtn.addEventListener("click", () => {
    approveAllGhostNodes();
  });
  
  // Load existing goals into canvas nodes
  if (state.goals && state.goals.length > 0) {
    goalCanvasNodes = state.goals.map(goal => ({
      id: goal.id,
      text: goal.name,
      level: goal.level || "lifetime",
      x: goal.canvasX || 50,
      y: goal.canvasY || 50,
      parentId: goal.parentId || null,
      isGhost: false
    }));
    renderGoalNodes();
    updateApproveAllButton(); // Show button if ghost nodes exist
    
    // Sync daily goals to tasks on load
    syncDailyGoalsToTasks();
  }
  
  // Canvas click handling removed - nodes are added via + Add buttons in list headers
  
  // Tab key to approve ghost nodes (only when editor is open and node is ghost)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && selectedNodeId) {
      const node = goalCanvasNodes.find(n => n.id === selectedNodeId);
      if (node && node.isGhost) {
        e.preventDefault();
        approveGhostNode(selectedNodeId);
      }
    }
  });
  
  // Goal editor handlers
  const saveGoalBtn = $("#saveGoalBtn");
  const confirmGhostBtn = $("#confirmGhostBtn");
  const deleteGoalBtn = $("#deleteGoalBtn");
  const goalEditorText = $("#goalEditorText");
  
  if (saveGoalBtn) {
    saveGoalBtn.addEventListener("click", () => {
      if (selectedNodeId) {
        const node = goalCanvasNodes.find(n => n.id === selectedNodeId);
        if (node && goalEditorText) {
          // Don't allow saving ghost nodes - they must be confirmed first
          if (node.isGhost) {
            alert("Please click 'Confirm Suggestion' to approve this AI suggestion, or edit it first.");
            return;
          }
          
          const oldText = node.text;
          node.text = goalEditorText.value.trim();
          node.isGhost = false;
          renderGoalNodes();
          saveGoalCanvas();
          
          // Generate AI suggestions if text changed and is meaningful
          if (node.text && node.text !== "New Goal" && node.text !== oldText) {
            // Auto-generate suggestions for all nodes in this level
            autoGenerateNextLevelSuggestions(node.level);
          }
        }
      }
      hideGoalEditor();
    });
  }
  
  if (confirmGhostBtn) {
    confirmGhostBtn.addEventListener("click", () => {
      if (selectedNodeId) {
        approveGhostNode(selectedNodeId);
      }
    });
  }
  
  if (deleteGoalBtn) {
    deleteGoalBtn.addEventListener("click", () => {
      if (selectedNodeId) {
        deleteGoalNode(selectedNodeId);
      }
    });
  }
  
  // Finish goals button
  const finishGoalsBtn = $("#finishGoalsBtn");
  if (finishGoalsBtn) {
    finishGoalsBtn.addEventListener("click", () => {
      // Goals are already saved automatically via saveGoalCanvas()
      // Just finish onboarding
      onboardingMode = null;
      shouldShowOnboarding = false;
      applyOnboardingModeUI();
      setStep(null);
      restoreFromState();
      startReflectionChecker();
    });
  }
  
  // Back button
  const backToProfileBtn = $("#backToProfileBtn");
  if (backToProfileBtn) {
    backToProfileBtn.addEventListener("click", () => {
      setStep(1);
    });
  }
}

// User's chosen long-term goal timeframe
let userLongTermTimeframe = "lifetime"; // Default, can be changed by user

function renderGoalCanvas() {
  const canvas = $("#goalCanvas");
  if (!canvas) {
    console.error("Canvas element not found in renderGoalCanvas");
    return;
  }
  
  // Save the approve all button before clearing
  const approveAllBtn = $("#approveAllGhostsBtn");
  
  canvas.innerHTML = "";
  
  // Create minimalist timeframe selector
  const timeframeSelector = document.createElement("div");
  timeframeSelector.className = "goal-timeframe-selector";
  timeframeSelector.innerHTML = `
    <select id="longTermTimeframeSelect">
      <option value="lifetime" ${userLongTermTimeframe === "lifetime" ? "selected" : ""}>Lifetime</option>
      <option value="yearly" ${userLongTermTimeframe === "yearly" ? "selected" : ""}>Yearly</option>
      <option value="seasonal" ${userLongTermTimeframe === "seasonal" ? "selected" : ""}>Seasonal</option>
      <option value="monthly" ${userLongTermTimeframe === "monthly" ? "selected" : ""}>Monthly</option>
    </select>
    <button id="addLongTermGoalBtn" class="btn-add-goal">+ Add</button>
  `;
  canvas.appendChild(timeframeSelector);
  
  // Handle timeframe change
  const select = timeframeSelector.querySelector("#longTermTimeframeSelect");
  select.addEventListener("change", (e) => {
    userLongTermTimeframe = e.target.value;
    renderGoalNodes();
  });
  
  // Handle add goal button
  const addBtn = timeframeSelector.querySelector("#addLongTermGoalBtn");
  addBtn.addEventListener("click", () => {
    createGoalNode(userLongTermTimeframe, 0, 0);
  });
  
  // Create single list container
  const listContainer = document.createElement("ul");
  listContainer.className = "goal-list-main";
  listContainer.id = "goalListMain";
  canvas.appendChild(listContainer);
  
  // Re-add the approve all button if it existed
  if (approveAllBtn) {
    canvas.appendChild(approveAllBtn);
  } else {
    // Create the button if it doesn't exist
    const newBtn = document.createElement("button");
    newBtn.id = "approveAllGhostsBtn";
    newBtn.className = "btn-approve-all-ghosts hidden";
    newBtn.textContent = "Approve All AI Suggestions";
    newBtn.addEventListener("click", () => {
      approveAllGhostNodes();
    });
    canvas.appendChild(newBtn);
  }
  
  console.log("Goal canvas rendered with single list structure");
}

function renderGoalNodes() {
  const canvas = $("#goalCanvas");
  if (!canvas) return;
  
  const listContainer = canvas.querySelector("#goalListMain");
  if (!listContainer) return;
  
  // Clear all list items
  listContainer.innerHTML = "";
  
  // Get all top-level goals (goals with no parent, matching user's long-term timeframe)
  const topLevelGoals = goalCanvasNodes.filter(n => 
    !n.parentId && n.level === userLongTermTimeframe
  );
  
  // Render each top-level goal and its children recursively
  topLevelGoals.forEach(goal => {
    const listItem = createListItemElement(goal);
    listContainer.appendChild(listItem);
    
    // Recursively add children
    addChildrenToList(listItem, goal.id);
  });
  
  // Show/hide "Approve All" button based on whether there are ghost nodes
  updateApproveAllButton();
}

function addChildrenToList(parentElement, parentId) {
  const children = goalCanvasNodes.filter(n => n.parentId === parentId);
  if (children.length === 0) return;
  
  const childrenList = document.createElement("ul");
  childrenList.className = "goal-list-children";
  // Start expanded by default (not collapsed)
  
  children.forEach(child => {
    const childItem = createListItemElement(child);
    childrenList.appendChild(childItem);
    
    // Recursively add grandchildren
    addChildrenToList(childItem, child.id);
  });
  
  parentElement.appendChild(childrenList);
  
  // Update the toggle arrow to show expanded state (▼)
  const toggle = parentElement.querySelector(".goal-list-toggle");
  if (toggle) {
    toggle.textContent = "▼";
  }
}

function createListItemElement(node) {
  const item = document.createElement("li");
  item.className = "goal-list-item";
  item.classList.add(`goal-level-${node.level}`); // Add level class for color coding
  if (node.isGhost) {
    item.classList.add("ghost");
  }
  if (selectedNodeId === node.id) {
    item.classList.add("selected");
  }
  item.dataset.nodeId = node.id;
  item.dataset.level = node.level;
  
  // Check if this node has children
  const hasChildren = goalCanvasNodes.some(n => n.parentId === node.id);
  
  const content = document.createElement("div");
  content.className = "goal-list-item-content";
  
  // Collapse/expand toggle (only if has children)
  if (hasChildren) {
    const toggle = document.createElement("span");
    toggle.className = "goal-list-toggle";
    toggle.textContent = "▼"; // Start expanded
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      // Find the children list - it might be added after this item
      const childrenList = item.querySelector(".goal-list-children");
      if (childrenList) {
        const isCollapsed = childrenList.classList.contains("collapsed");
        if (isCollapsed) {
          childrenList.classList.remove("collapsed");
          toggle.textContent = "▼";
        } else {
          childrenList.classList.add("collapsed");
          toggle.textContent = "▶";
        }
      }
    });
    content.appendChild(toggle);
  } else {
    // Empty spacer if no children
    const spacer = document.createElement("span");
    spacer.className = "goal-list-toggle-spacer";
    content.appendChild(spacer);
  }
  
  // Minimalist color tag (just a small dot)
  const tag = document.createElement("span");
  tag.className = "goal-timeframe-tag";
  tag.title = `${LEVEL_LABELS[node.level] || node.level}`;
  content.appendChild(tag);
  
  const text = document.createElement("span");
  text.className = "goal-list-item-text";
  text.textContent = node.text || "New Goal";
  content.appendChild(text);
  
  const actions = document.createElement("div");
  actions.className = "goal-list-item-actions";
  
  if (node.isGhost) {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-icon-sm btn-confirm-ghost";
    confirmBtn.textContent = "✓";
    confirmBtn.title = "Confirm suggestion";
    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      approveGhostNode(node.id);
    });
    actions.appendChild(confirmBtn);
  }
  
  const editBtn = document.createElement("button");
  editBtn.className = "btn-icon-sm btn-edit-goal";
  editBtn.textContent = "✎";
  editBtn.title = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectGoalNode(node.id);
  });
  actions.appendChild(editBtn);
  
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-icon-sm btn-delete-goal";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteGoalNode(node.id);
  });
  actions.appendChild(deleteBtn);
  
  content.appendChild(actions);
  item.appendChild(content);
  
  return item;
}

function updateApproveAllButton() {
  const approveAllBtn = $("#approveAllGhostsBtn");
  if (!approveAllBtn) return;
  
  const hasGhostNodes = goalCanvasNodes.some(n => n.isGhost);
  if (hasGhostNodes) {
    approveAllBtn.classList.remove("hidden");
  } else {
    approveAllBtn.classList.add("hidden");
  }
}

function approveAllGhostNodes() {
  const ghostNodes = goalCanvasNodes.filter(n => n.isGhost);
  
  if (ghostNodes.length === 0) {
    return;
  }
  
  // Approve each ghost node
  ghostNodes.forEach(ghostNode => {
    ghostNode.isGhost = false;
    ghostNode.id = `goal_node_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  });
  
  // Remove duplicates (keep only the approved versions)
  const approvedIds = new Set(ghostNodes.map(n => n.id));
  goalCanvasNodes = goalCanvasNodes.filter(n => 
    !n.isGhost || approvedIds.has(n.id)
  );
  
  // Re-render to show approved nodes
  renderGoalNodes();
  saveGoalCanvas();
  
  // Hide the approve all button since no ghosts remain
  updateApproveAllButton();
  
  // Auto-generate suggestions for the next level for all approved nodes
  const approvedLevels = new Set(ghostNodes.map(n => n.level));
  approvedLevels.forEach(level => {
    autoGenerateNextLevelSuggestions(level);
  });
  
  console.log(`Approved ${ghostNodes.length} AI suggestions`);
}

// Removed old node-based functions: cleanupOrphanedLines, drawConnectionLine, createNodeElement
// Now using list-based structure

function createGoalNode(level, x, y) {
  const nodeId = `goal_node_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const newNode = {
    id: nodeId,
    text: "New Goal",
    level: level,
    x: x,
    y: y,
    parentId: null,
    isGhost: false
  };
  
  goalCanvasNodes.push(newNode);
  renderGoalNodes();
  selectGoalNode(nodeId);
  
  // Don't generate suggestions yet - wait until user edits the node
}

// Auto-generate suggestions for all nodes in a given level
async function autoGenerateNextLevelSuggestions(parentLevel) {
  const currentIndex = GOAL_LEVELS.indexOf(parentLevel);
  if (currentIndex >= GOAL_LEVELS.length - 1) return; // No child level available
  
  const childLevel = GOAL_LEVELS[currentIndex + 1];
  
  // Get all non-ghost nodes in the parent level
  const parentNodes = goalCanvasNodes.filter(n => 
    n.level === parentLevel && 
    !n.isGhost && 
    n.text && 
    n.text.trim() !== "" && 
    n.text !== "New Goal"
  );
  
  if (parentNodes.length === 0) return;
  
  console.log(`Auto-generating ${childLevel} suggestions for ${parentNodes.length} ${parentLevel} goals`);
  
  // Remove existing ghost nodes for the child level
  goalCanvasNodes = goalCanvasNodes.filter(n => 
    !(n.isGhost && n.level === childLevel)
  );
  
  // Generate suggestions for each parent node
  for (const parentNode of parentNodes) {
    await generateGoalSuggestions(parentNode.id, parentLevel);
    // Small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  renderGoalNodes();
  updateApproveAllButton();
}

async function generateGoalSuggestions(parentNodeId, parentLevel) {
  const parentNode = goalCanvasNodes.find(n => n.id === parentNodeId);
  if (!parentNode) {
    console.error("Parent node not found for suggestions");
    return;
  }
  
  if (!parentNode.text || parentNode.text.trim() === "" || parentNode.text === "New Goal") {
    console.log("Skipping suggestions - parent node has no meaningful text");
    return;
  }
  
  // Determine child level
  const currentIndex = GOAL_LEVELS.indexOf(parentLevel);
  if (currentIndex >= GOAL_LEVELS.length - 1) return; // No child level available
  
  const childLevel = GOAL_LEVELS[currentIndex + 1];
  
  // Show loading spinner
  const canvas = $("#goalCanvas");
  if (canvas) {
    const levelIndex = GOAL_LEVELS.indexOf(childLevel);
    const section = canvas.children[levelIndex];
    if (section) {
      // Remove existing spinner
      section.querySelectorAll(".goal-loading-spinner").forEach(spinner => spinner.remove());
      
      const spinner = document.createElement("div");
      spinner.className = "goal-loading-spinner";
      section.appendChild(spinner);
    }
  }
  
  // Create level-specific instructions with clear timeframes
  const timeframeContext = {
    lifetime: "Lifetime goals span decades - these are your ultimate life aspirations.",
    yearly: "Yearly goals are accomplished within ONE CALENDAR YEAR (12 months). Think: 'What can I achieve in 2024?' or 'What milestone can I reach by December 31st?'",
    seasonal: "Seasonal goals are accomplished within ONE QUARTER (3 months). Think: 'What can I achieve in Q1 (Jan-Mar)?' or 'What can I complete in this 3-month period?'",
    monthly: "Monthly goals are accomplished within ONE MONTH (30 days). Think: 'What can I achieve in January?' or 'What can I complete in the next 30 days?'",
    weekly: "Weekly goals are accomplished within ONE WEEK (7 days). Think: 'What can I achieve this week?' or 'What tasks can I complete from Monday to Sunday?'",
    daily: "Daily goals are accomplished within ONE DAY (24 hours). Think: 'What can I achieve today?' or 'What specific task can I complete today?'"
  };
  
  const parentTimeframe = timeframeContext[parentLevel] || "";
  const childTimeframe = timeframeContext[childLevel] || "";
  
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Break down this ${parentLevel} goal into ${childLevel} goals.

TIME CONTEXT:
${parentTimeframe}
${childTimeframe}

The parent goal "${parentNode.text}" is a ${parentLevel} goal. You need to suggest 1-2 ${childLevel} goals that:
1. Can be accomplished within the ${childLevel} timeframe (${childLevel === 'yearly' ? '12 months' : childLevel === 'seasonal' ? '3 months' : childLevel === 'monthly' ? '30 days' : childLevel === 'weekly' ? '7 days' : '1 day'})
2. Are concrete steps toward the parent ${parentLevel} goal
3. Are realistic for the timeframe (don't suggest too much)
4. Are concise (2-5 words each)

IMPORTANT: Only suggest 1-2 goals maximum. Focus on quality over quantity. Each suggestion must be achievable within the ${childLevel} timeframe.

Return ONLY the ${childLevel} goal suggestions, one per line, without numbers, bullets, or formatting.`,
        context: `User profile: ${JSON.stringify(state.profile || {})}. Goal hierarchy: ${parentLevel} → ${childLevel}. Timeframe: ${childLevel === 'yearly' ? '12 months' : childLevel === 'seasonal' ? '3 months' : childLevel === 'monthly' ? '30 days' : childLevel === 'weekly' ? '7 days' : '1 day'}`,
      }),
    });
    
    if (res.ok) {
      const data = await res.json();
      const replyText = data.reply || "";
      console.log("AI suggestions received:", replyText);
      
      const suggestions = replyText
        .split("\n")
        .map(s => s.trim())
        .filter(s => s && s.length > 0 && !s.match(/^[\d\-\*•]/))
        .slice(0, 2); // Reduced to 1-2 suggestions
      
      console.log("Parsed suggestions:", suggestions);
      
      if (suggestions.length === 0) {
        console.warn("No valid suggestions parsed from AI response");
        return;
      }
      
      // Remove any existing ghost nodes for this parent
      goalCanvasNodes = goalCanvasNodes.filter(n => 
        !(n.isGhost && n.parentId === parentNodeId)
      );
      
      // Create ghost nodes for suggestions
      suggestions.forEach((suggestion, index) => {
        const ghostNode = {
          id: `ghost_${parentNodeId}_${index}`,
          text: suggestion,
          level: childLevel,
          x: 0, // Will be centered by render function
          y: 0, // Will be positioned by render function
          parentId: parentNodeId,
          isGhost: true
        };
        goalCanvasNodes.push(ghostNode);
        console.log("Created ghost node:", ghostNode);
      });
      
      renderGoalNodes();
      updateApproveAllButton(); // Show button if ghost nodes exist
      console.log("Ghost nodes rendered, total nodes:", goalCanvasNodes.length);
    } else {
      console.error("AI API error:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Error generating goal suggestions:", err);
  } finally {
    // Remove loading spinner
    if (canvas) {
      const parentItem = canvas.querySelector(`[data-node-id="${parentNodeId}"]`);
      if (parentItem) {
        parentItem.querySelectorAll(".goal-loading-spinner").forEach(spinner => spinner.remove());
      }
    }
  }
}

function approveGhostNode(nodeId) {
  const node = goalCanvasNodes.find(n => n.id === nodeId);
  if (!node || !node.isGhost) return;
  
  node.isGhost = false;
  node.id = `goal_node_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  
  // Remove other ghost nodes with same parent
  goalCanvasNodes = goalCanvasNodes.filter(n => 
    !(n.isGhost && n.parentId === node.parentId) || n.id === node.id
  );
  
  renderGoalNodes();
  updateApproveAllButton(); // Update button visibility
  selectGoalNode(node.id);
  saveGoalCanvas();
  
  // Auto-generate suggestions for all nodes in this level
  autoGenerateNextLevelSuggestions(node.level);
}

function selectGoalNode(nodeId) {
  selectedNodeId = nodeId;
  const node = goalCanvasNodes.find(n => n.id === nodeId);
  if (node) {
    showGoalEditor(node);
  }
  renderGoalNodes();
}

function showGoalEditor(node) {
  const editorPanel = $("#goalEditorPanel");
  const editorText = $("#goalEditorText");
  const saveBtn = $("#saveGoalBtn");
  const confirmBtn = $("#confirmGhostBtn");
  
  if (editorPanel && editorText) {
    editorPanel.classList.remove("hidden");
    editorText.value = node.text;
    
    // Show/hide buttons based on whether node is a ghost
    if (node.isGhost) {
      // Ghost node: show confirm button, hide save button
      if (confirmBtn) {
        confirmBtn.classList.remove("hidden");
      }
      if (saveBtn) {
        saveBtn.classList.add("hidden");
      }
      editorText.readOnly = true; // Make read-only for ghost nodes
    } else {
      // Regular node: show save button, hide confirm button
      if (confirmBtn) {
        confirmBtn.classList.add("hidden");
      }
      if (saveBtn) {
        saveBtn.classList.remove("hidden");
      }
      editorText.readOnly = false; // Allow editing for regular nodes
    }
    
    editorText.focus();
  }
}

function hideGoalEditor() {
  const editorPanel = $("#goalEditorPanel");
  if (editorPanel) {
    editorPanel.classList.add("hidden");
  }
  selectedNodeId = null;
}

function deleteGoalNode(nodeId) {
  // Recursively find all children and descendants to delete
  const toDelete = new Set([nodeId]);
  
  const findChildren = (parentId) => {
    goalCanvasNodes.forEach(node => {
      if (node.parentId === parentId && !toDelete.has(node.id)) {
        toDelete.add(node.id);
        findChildren(node.id); // Recursively find grandchildren
      }
    });
  };
  
  // Find all descendants
  findChildren(nodeId);
  
  console.log("Deleting nodes:", Array.from(toDelete));
  
  // Remove all nodes (parent and all descendants)
  goalCanvasNodes = goalCanvasNodes.filter(n => !toDelete.has(n.id));
  
  // Clear selection if deleted node was selected
  if (toDelete.has(selectedNodeId)) {
    hideGoalEditor();
  }
  
  // Re-render to remove nodes
  renderGoalNodes();
  updateApproveAllButton(); // Update button visibility
  saveGoalCanvas();
  
  // Auto-regenerate suggestions for all levels that might have been affected
  // After deletion, regenerate suggestions for remaining nodes in each level
  GOAL_LEVELS.forEach(level => {
    const nodesInLevel = goalCanvasNodes.filter(n => 
      n.level === level && 
      !n.isGhost && 
      n.text && 
      n.text.trim() !== "" && 
      n.text !== "New Goal"
    );
    if (nodesInLevel.length > 0) {
      autoGenerateNextLevelSuggestions(level);
    }
  });
  const deletedNode = goalCanvasNodes.find(n => n.id === nodeId);
  if (deletedNode) {
    // Actually, the node is already deleted, so we need to check parent level
    // Instead, regenerate suggestions for all levels that might be affected
    GOAL_LEVELS.forEach(level => {
      const nodesInLevel = goalCanvasNodes.filter(n => n.level === level && !n.isGhost);
      if (nodesInLevel.length > 0) {
        autoGenerateNextLevelSuggestions(level);
      }
    });
  }
}

// Removed startDrag - no longer needed with list structure

function saveGoalCanvas() {
  // Auto-save goals whenever canvas changes
  state.goals = goalCanvasNodes
    .filter(n => !n.isGhost)
    .map(node => ({
      id: node.id,
      name: node.text,
      level: node.level,
      parentId: node.parentId,
      canvasX: node.x,
      canvasY: node.y,
      color: generateGoalColor(node.level)
    }));
  
  saveUserData();
  
  // Sync daily goals to tasks
  syncDailyGoalsToTasks();
  
  // Auto-render calendar if we have tasks
  if (state.tasks && state.tasks.length > 0 && state.profile) {
    generateSchedule();
  }
}

// Sync daily goals to tasks
function syncDailyGoalsToTasks() {
  if (!state.goals) {
    console.log("No goals found for syncing");
    return;
  }
  
  // Get all daily goals (including from canvas nodes if not yet saved)
  let dailyGoals = [];
  
  // First check canvas nodes (for goals being edited)
  if (goalCanvasNodes && goalCanvasNodes.length > 0) {
    dailyGoals = goalCanvasNodes
      .filter(n => !n.isGhost && n.level === "daily" && n.text && n.text.trim() !== "" && n.text !== "New Goal")
      .map(node => ({
        id: node.id,
        name: node.text,
        level: node.level
      }));
  }
  
  // Also check saved goals
  const savedDailyGoals = (state.goals || []).filter(g => 
    g.level === "daily" && g.name && g.name.trim() !== "" && g.name !== "New Goal"
  );
  
  // Merge and deduplicate
  const allDailyGoals = [...dailyGoals];
  savedDailyGoals.forEach(goal => {
    if (!allDailyGoals.find(g => g.id === goal.id)) {
      allDailyGoals.push(goal);
    }
  });
  
  console.log("Syncing daily goals to tasks:", allDailyGoals);
  
  if (!state.tasks) {
    state.tasks = [];
  }
  
  // Get existing task IDs that came from daily goals
  const existingGoalTaskIds = state.tasks
    .filter(t => t.fromDailyGoal)
    .map(t => t.goalId);
  
  // Create tasks for daily goals that don't have tasks yet
  allDailyGoals.forEach(goal => {
    if (!existingGoalTaskIds.includes(goal.id)) {
      const task = {
        id: `task_goal_${goal.id}`,
        name: goal.name,
        description: `Daily goal: ${goal.name}`,
        priority: "important-not-urgent",
        category: goal.name.toLowerCase().replace(/\s+/g, "-"),
        estimatedHours: 1, // Default 1 hour for daily goals
        deadline: null,
        completed: false,
        fromDailyGoal: true,
        goalId: goal.id
      };
      
      state.tasks.push(task);
      console.log("Created task from daily goal:", task);
    } else {
      // Update existing task if goal name changed
      const existingTask = state.tasks.find(t => t.goalId === goal.id);
      if (existingTask && existingTask.name !== goal.name) {
        existingTask.name = goal.name;
        existingTask.description = `Daily goal: ${goal.name}`;
        existingTask.category = goal.name.toLowerCase().replace(/\s+/g, "-");
        console.log("Updated task from daily goal:", existingTask);
      }
    }
  });
  
  // Remove tasks for goals that no longer exist
  const dailyGoalIds = new Set(allDailyGoals.map(g => g.id));
  state.tasks = state.tasks.filter(t => {
    if (t.fromDailyGoal) {
      const goalExists = dailyGoalIds.has(t.goalId);
      if (!goalExists) {
        // Also remove from schedule
        if (state.schedule) {
          state.schedule = state.schedule.filter(s => s.taskId !== t.id);
        }
        console.log("Removed task for deleted daily goal:", t.id);
        return false;
      }
    }
    return true;
  });
  
  saveUserData();
  renderTasks();
  renderTaskSummary();
}

// Manual sync function for the button
function manualSyncCalendar() {
  console.log("Manual calendar sync triggered");
  
  // First sync daily goals to tasks
  syncDailyGoalsToTasks();
  
  // Then regenerate schedule if we have tasks and profile
  if (state.tasks && state.tasks.length > 0 && state.profile) {
    console.log("Regenerating schedule with", state.tasks.length, "tasks");
    generateSchedule();
  } else {
    console.log("No tasks or profile available for schedule generation");
    // Clear schedule if no tasks
    state.schedule = [];
    renderSchedule();
  }
  
  // Show feedback
  const syncBtn = $("#syncCalendarBtn");
  if (syncBtn) {
    const originalText = syncBtn.innerHTML;
    syncBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><path d="M8 1v6l4-4M8 15V9l-4 4"/></svg>Synced!';
    syncBtn.disabled = true;
    setTimeout(() => {
      syncBtn.innerHTML = originalText;
      syncBtn.disabled = false;
    }, 2000);
  }
}

function generateGoalColor(level) {
  const colors = {
    lifetime: { bg: "rgba(139, 92, 246, 0.15)", border: "rgba(139, 92, 246, 0.3)", text: "#7c3aed" },
    yearly: { bg: "rgba(14, 165, 233, 0.15)", border: "rgba(14, 165, 233, 0.3)", text: "#0284c7" },
    seasonal: { bg: "rgba(236, 72, 153, 0.15)", border: "rgba(236, 72, 153, 0.3)", text: "#db2777" },
    monthly: { bg: "rgba(34, 197, 94, 0.15)", border: "rgba(34, 197, 94, 0.3)", text: "#16a34a" },
    weekly: { bg: "rgba(251, 146, 60, 0.15)", border: "rgba(251, 146, 60, 0.3)", text: "#ea580c" },
    daily: { bg: "rgba(168, 85, 247, 0.15)", border: "rgba(168, 85, 247, 0.3)", text: "#7c3aed" }
  };
  return colors[level] || colors.lifetime;
}

// ---------- Daily Habits Management ----------

function initDailyHabits() {
  const addHabitBtn = $("#addHabitBtn");
  if (addHabitBtn) {
    // Remove existing listener by cloning and replacing
    const newAddHabitBtn = addHabitBtn.cloneNode(true);
    addHabitBtn.parentNode?.replaceChild(newAddHabitBtn, addHabitBtn);
    newAddHabitBtn.addEventListener("click", () => {
      const habitName = prompt("Enter habit name:");
      if (!habitName || !habitName.trim()) return;
      
      const habitTime = prompt("Enter time (e.g., 08:00 or 8:00 AM):");
      if (!habitTime || !habitTime.trim()) return;
      
      addDailyHabit(habitName.trim(), habitTime.trim());
    });
  }
  
  renderDailyHabits();
}

function addDailyHabit(name, time) {
  if (!state.dailyHabits) {
    state.dailyHabits = [];
  }
  
  const habit = {
    id: `habit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name: name,
    time: time,
    description: "",
  };
  
  state.dailyHabits.push(habit);
  saveUserData();
  renderDailyHabits();
}

function deleteDailyHabit(habitId) {
  if (!confirm("Are you sure you want to delete this habit?")) {
    return;
  }
  
  state.dailyHabits = state.dailyHabits.filter(h => h.id !== habitId);
  saveUserData();
  renderDailyHabits();
}

function renderDailyHabits() {
  const container = $("#habitsList");
  if (!container) return;
  
  container.innerHTML = "";
  
  if (!state.dailyHabits || state.dailyHabits.length === 0) {
    container.innerHTML = '<div class="goals-empty">No habits yet. Click "+ Add Daily Habit" to create one.</div>';
    return;
  }
  
  // Sort habits by time
  const sortedHabits = [...state.dailyHabits].sort((a, b) => {
    // Simple time comparison (assumes format like "08:00" or "8:00 AM")
    const timeA = parseTimeToMinutes(a.time) || 0;
    const timeB = parseTimeToMinutes(b.time) || 0;
    return timeA - timeB;
  });
  
  sortedHabits.forEach(habit => {
    const habitItem = document.createElement("div");
    habitItem.className = "habit-item";
    habitItem.innerHTML = `
      <div style="flex: 1;">
        <span class="habit-name">${habit.name}</span>
        <span class="habit-time">${habit.time}</span>
      </div>
      <button type="button" class="habit-delete-btn" data-habit-id="${habit.id}" title="Delete habit">×</button>
    `;
    container.appendChild(habitItem);
  });
  
  // Handle delete button clicks (use onclick to replace handler)
  container.onclick = (e) => {
    const deleteBtn = e.target.closest(".habit-delete-btn");
    if (deleteBtn) {
      const habitId = deleteBtn.dataset.habitId;
      if (habitId) {
        deleteDailyHabit(habitId);
      }
      e.stopPropagation();
    }
  };
}

function ensureTaskIds() {
  if (!state.tasks) {
    state.tasks = [];
    return;
  }
  let changed = false;
  state.tasks.forEach((t) => {
    if (!t.id) {
      t.id = `task_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      changed = true;
    }
    if (typeof t.completed !== "boolean") {
      t.completed = false;
      changed = true;
    }
  });
  if (changed) {
    saveUserData();
  }
}

function deleteTask(taskId) {
  // Confirm deletion
  if (!confirm("Are you sure you want to delete this task? This will also remove it from your schedule.")) {
    return;
  }

  // Remove task from tasks array
  state.tasks = state.tasks.filter((t) => t.id !== taskId);

  // Remove scheduled blocks for this task
  state.schedule = state.schedule.filter((s) => s.taskId !== taskId);

  // Remove from ranked tasks
  if (state.rankedTasks) {
    state.rankedTasks = state.rankedTasks.filter((t) => t.id !== taskId);
  }

  // Clear editing if this was the task being edited
  if (editingTaskId === taskId) {
    editingTaskId = null;
    const taskForm = $("#taskForm");
    if (taskForm) {
      taskForm.reset();
      const submitBtn = taskForm.querySelector("button[type=submit]");
      if (submitBtn) submitBtn.textContent = "Add task to list";
    }
  }

  saveUserData();
  renderTasks();
  renderTaskSummary();
  renderRankedPreview();
  
  // Auto-regenerate schedule after task deletion
  if (state.tasks.length > 0 && state.profile) {
    generateSchedule();
  } else {
    // Clear schedule if no tasks
    state.schedule = [];
    renderSchedule();
  }
  
  // Update plan button state
  $("#planTasksBtn").disabled = state.tasks.length === 0;
}

function renderTasks() {
  const container = $("#taskList");
  if (!container) return;
  container.innerHTML = "";

  const tasks = [...state.tasks];
  tasks.sort((a, b) => {
    // Incomplete first, then by priority & deadline
    const ca = a.completed ? 1 : 0;
    const cb = b.completed ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const pa = PRIORITY_WEIGHTS[a.task_priority] ?? 99;
    const pb = PRIORITY_WEIGHTS[b.task_priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.task_deadline.localeCompare(b.task_deadline);
  });

  tasks.forEach((task) => {
    const wrapper = document.createElement("div");
    wrapper.className = "task-item" + (task.completed ? " task-completed" : "");
    const priorityKey = (task.task_priority || "").toLowerCase().replace(/[^a-z]+/g, "-");
    wrapper.innerHTML = `
      <div class="task-checkbox">
        <div class="checkbox-fancy${task.completed ? " completed" : ""}" data-id="${task.id}">
          <div class="checkbox-fancy-inner"></div>
        </div>
      </div>
      <div class="task-content">
        <div class="task-title">
          ${task.task_name}
          ${(() => {
            const catInfo = getCategoryInfo(task.task_category || 'study');
            if (catInfo.isGoal && catInfo.color) {
              return `<span class="category-tag category-goal" style="background: ${catInfo.color.bg}; color: ${catInfo.color.text}; border: 1px solid ${catInfo.color.border}">${catInfo.name}</span>`;
            } else {
              return `<span class="category-tag category-${task.task_category || 'study'}">${catInfo.name}</span>`;
            }
          })()}
        </div>
        <div class="task-meta">
          <span class="priority-pill priority-${priorityKey}">${task.task_priority}</span>
          <span class="task-badge">Due ${task.task_deadline} ${task.task_deadline_time}</span>
          <span class="task-badge">${task.task_duration_hours}h</span>
          <button type="button" class="task-edit-btn" data-id="${task.id}">Edit</button>
          <button type="button" class="task-delete-btn" data-id="${task.id}" title="Delete task">🗑️</button>
        </div>
      </div>
    `;
    container.appendChild(wrapper);
  });

  // completion toggle, edit, and delete handlers
  container.onclick = (e) => {
    const deleteBtn = e.target.closest(".task-delete-btn");
    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      if (id) {
        deleteTask(id);
        e.stopPropagation();
      }
      return;
    }

    const editBtn = e.target.closest(".task-edit-btn");
    if (editBtn) {
      const id = editBtn.dataset.id;
      if (id) startEditTask(id);
      e.stopPropagation();
      return;
    }

    const checkbox = e.target.closest(".checkbox-fancy");
    if (checkbox) {
      const id = checkbox.dataset.id;
      const task = state.tasks.find((t) => t.id === id);
      if (task) {
        task.completed = !task.completed;
        saveUserData();
        // Re-render so completed items move down & get styling
        renderTasks();
        renderTaskSummary();
      }
      return;
    }

    // Click on task content to open Pomodoro timer
    const taskEl = e.target.closest(".task-item");
    if (taskEl) {
      const id = taskEl.querySelector(".checkbox-fancy")?.dataset.id;
      if (id) openPomodoroTimer(id);
    }
  };
}

function renderTaskSummary() {
  const container = $("#taskSummaryList");
  if (!container) return;
  container.innerHTML = "";
  const tasks = [...state.tasks];
  tasks.sort((a, b) => {
    const ca = a.completed ? 1 : 0;
    const cb = b.completed ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const pa = PRIORITY_WEIGHTS[a.task_priority] ?? 99;
    const pb = PRIORITY_WEIGHTS[b.task_priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.task_deadline.localeCompare(b.task_deadline);
  });
  tasks.forEach((t, idx) => {
    const item = document.createElement("div");
    item.className = "task-summary-item" + (t.completed ? " task-summary-completed" : "");
    const priorityKey = (t.task_priority || "").toLowerCase().replace(/[^a-z]+/g, "-");
    item.innerHTML = `
      ${(() => {
        const catInfo = getCategoryInfo(t.task_category || 'study');
        let tagHtml;
        if (catInfo.isGoal && catInfo.color) {
          tagHtml = `<span class="category-tag category-goal" style="background: ${catInfo.color.bg}; color: ${catInfo.color.text}; border: 1px solid ${catInfo.color.border}">${catInfo.name}</span>`;
        } else {
          tagHtml = `<span class="category-tag category-${t.task_category || 'study'}">${catInfo.name}</span>`;
        }
        return `<span>${idx + 1}. ${t.task_name} ${tagHtml}</span>`;
      })()}
      <span>
        <button type="button" class="task-edit-btn" data-id="${t.id}">Edit</button>
        <button type="button" class="task-delete-btn" data-id="${t.id}" title="Delete task">🗑️</button>
        <span class="priority-pill priority-${priorityKey}">${t.task_priority}</span>
      </span>
    `;
    container.appendChild(item);
  });
  $("#planTasksBtn").disabled = tasks.length === 0;

  // Delegate edit and delete button clicks
  container.onclick = (e) => {
    const deleteBtn = e.target.closest(".task-delete-btn");
    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      if (id) {
        deleteTask(id);
        e.stopPropagation();
      }
      return;
    }

    const editBtn = e.target.closest(".task-edit-btn");
    if (editBtn) {
      const id = editBtn.dataset.id;
    if (id) startEditTask(id);
      e.stopPropagation();
    }
  };
}

function startEditTask(taskId) {
  openTaskEditor(taskId);
}

function rankTasks() {
  const tasks = [...state.tasks];
  tasks.sort((a, b) => {
    const pa = PRIORITY_WEIGHTS[a.task_priority] ?? 99;
    const pb = PRIORITY_WEIGHTS[b.task_priority] ?? 99;
    if (pa !== pb) return pa - pb;
    const da = `${a.task_deadline}T${a.task_deadline_time}`;
    const db = `${b.task_deadline}T${b.task_deadline_time}`;
    return da.localeCompare(db);
  });
  state.rankedTasks = tasks;
  saveUserData();
}

function renderRankedPreview() {
  const container = $("#rankedTaskPreview");
  if (!container) return;
  container.innerHTML = "";
  if (!state.rankedTasks || state.rankedTasks.length === 0) {
    container.textContent = "No tasks yet. Go back and add some tasks first.";
    return;
  }
  state.rankedTasks.forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "ranked-preview-item";
    const priorityKey = (t.task_priority || "").toLowerCase().replace(/[^a-z]+/g, "-");
    row.innerHTML = `
      <span>${idx + 1}. ${t.task_name}</span>
      <span>
        <span class="priority-pill priority-${priorityKey}">${t.task_priority}</span>
        <span class="task-badge">Due ${t.task_deadline}</span>
      </span>
    `;
    container.appendChild(row);
  });
}

function initWizardButtons() {
  // Remove existing listeners by cloning and replacing elements
  const backToProfileBtn = $("#backToProfileBtn");
  if (backToProfileBtn) {
    const newBtn = backToProfileBtn.cloneNode(true);
    backToProfileBtn.parentNode?.replaceChild(newBtn, backToProfileBtn);
    newBtn.addEventListener("click", () => setStep(1));
  }
  
  const goToConfirmBtn = $("#goToConfirmBtn");
  if (goToConfirmBtn) {
    const newBtn = goToConfirmBtn.cloneNode(true);
    goToConfirmBtn.parentNode?.replaceChild(newBtn, goToConfirmBtn);
    newBtn.addEventListener("click", () => {
      if (onboardingMode === "personalization-only") {
        return; // Block navigation to confirm during personalization-only signup
      }
      rankTasks();
      renderRankedPreview();
      setStep(3);
    });
  }
  
  const editTasksBtn = $("#editTasksBtn");
  if (editTasksBtn) {
    const newBtn = editTasksBtn.cloneNode(true);
    editTasksBtn.parentNode?.replaceChild(newBtn, editTasksBtn);
    newBtn.addEventListener("click", () => {
      if (onboardingMode === "personalization-only") {
        return; // Block returning to tasks during personalization-only signup
      }
      setStep(2);
    });
  }

  const confirmGenerateBtn = $("#confirmGenerateBtn");
  if (confirmGenerateBtn) {
    const newBtn = confirmGenerateBtn.cloneNode(true);
    confirmGenerateBtn.parentNode?.replaceChild(newBtn, confirmGenerateBtn);
    newBtn.addEventListener("click", () => {
      if (!state.profile || !state.rankedTasks.length) {
        alert("Please complete your profile and tasks first.");
        return;
      }
      generateSchedule();
      renderSchedule();
      $("#calendarSubtitle").textContent =
        "Your tasks are time‑blocked so everything finishes before the deadline. You can click blocks to adjust or start focus.";
      // Close wizard after schedule is generated
      setStep(null);
    });
  }
}

// ---------- Scheduling Engine ----------
// AI-powered task scheduling that automatically places tasks based on learning personalization:
// - Uses preferred work style to determine chunk sizes (25min bursts, 60min deep sessions, etc.)
// - Adapts to procrastinator type (early scheduling, distributed, or intensive grouping)
// - Respects most productive time windows with intelligent slot scoring
// - Incorporates preferred study method patterns (Pomodoro, custom intervals)
// - Adds buffer time for users who have trouble finishing
// - Schedules breaks between chunks based on personalization

function generateSchedule() {
  const profile = state.profile;
  const tasks = [...state.rankedTasks];
  const schedule = [];
  const fixedBlocks = [];

  const startDate = new Date(todayLocalISODate() + "T00:00:00");

  // Build availability grid for next 14 days, 30-min slots
  const horizonDays = 14;
  const slotsByDay = [];

  for (let i = 0; i < horizonDays; i++) {
    const dayDate = new Date(startDate.getTime());
    dayDate.setDate(startDate.getDate() + i);
    const dayNameIndex = dayDate.getDay(); // 0=Sun
    const dayName = DAYS[(dayNameIndex + 6) % 7]; // map Mon=0

    const dailySlots = [];
    // 6:00 - 23:30
    for (let minute = 6 * 60; minute < 24 * 60; minute += 30) {
      dailySlots.push({
        startMinutes: minute,
        available: true,
        personal: false,
        reviewPreferred: false,
      });
    }

    // Block fixed weekly schedule for Mon-Fri (now array of {name, time, description})
    if (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dayName)) {
      const dayCommitments = profile.weekly_schedule?.[dayName];
      if (dayCommitments) {
        // Handle both old string format and new array format
        if (typeof dayCommitments === "string" && dayCommitments.trim()) {
          // Legacy: single time range string
          applyTimeRangeToSlots(dayCommitments, dailySlots, { available: false });
          createFixedBlocksForDay(dayCommitments, dayDate, "Fixed commitment", "routine", fixedBlocks);
        } else if (Array.isArray(dayCommitments)) {
          // New format: array of commitments
          dayCommitments.forEach((commitment) => {
            if (commitment.time) {
              applyTimeRangeToSlots(commitment.time, dailySlots, { available: false });
              const label = commitment.name || "Fixed commitment";
              createFixedBlocksForDay(commitment.time, dayDate, label, "routine", fixedBlocks);
            }
          });
        }
      }
    }

    // Block simple breaks (applied every day) and visualize them
    if (profile.break_times) {
      applyTimeRangeToSlots(profile.break_times, dailySlots, { available: false });
      createFixedBlocksForDay(profile.break_times, dayDate, "Break", "break", fixedBlocks);
    }

    // Weekend specific fixed activities (now structured format)
    if (["Sat", "Sun"].includes(dayName)) {
      const key = dayName === "Sat" ? "Saturday" : "Sunday";
      const dayActivities = profile.weekend_schedule?.[key];
      
      if (dayActivities) {
        // Handle both old string format (parsed) and new array format
        if (typeof profile.weekend_schedule === "string") {
          // Legacy: parse text format
          const weekendDefinitions = parseWeekendSchedule(profile.weekend_schedule);
          const defs = weekendDefinitions[key] || [];
          defs.forEach((def) => {
            applyTimeRangeToSlots(def.range, dailySlots, { available: false });
            createFixedBlocksForDay(def.range, dayDate, def.label || "Weekend activity", "weekend", fixedBlocks);
          });
        } else if (Array.isArray(dayActivities)) {
          // New format: array of {name, time, description}
          dayActivities.forEach((activity) => {
            if (activity.time) {
              applyTimeRangeToSlots(activity.time, dailySlots, { available: false });
              const label = activity.name || "Weekend activity";
              createFixedBlocksForDay(activity.time, dayDate, label, "weekend", fixedBlocks);
            }
          });
        }
      }
    }

    // Allocate weekly personal time as last N hours of week (rough heuristic)
    if (profile.weekly_personal_time > 0) {
      const totalPersonalMinutes = profile.weekly_personal_time * 60;
      const minutesPerDay = Math.floor(totalPersonalMinutes / 7);
      if (minutesPerDay > 0) {
        let minutesAssigned = 0;
        for (let idx = dailySlots.length - 1; idx >= 0 && minutesAssigned < minutesPerDay; idx--) {
          const slot = dailySlots[idx];
          slot.available = false;
          slot.personal = true;
          minutesAssigned += 30;
        }
      }
    }

    // Mark review-preferred slots if weekly_review_hours > 0 (morning sessions)
    if (profile.weekly_review_hours > 0) {
      for (const slot of dailySlots) {
        if (slot.startMinutes >= 8 * 60 && slot.startMinutes <= 11 * 60) {
          slot.reviewPreferred = true;
        }
      }
    }

    slotsByDay.push({
      date: dayDate,
      dayName,
      slots: dailySlots,
    });
  }

  // AI-powered task scheduling based on learning personalization
  tasks.forEach((task) => {
    const totalMinutes = Math.ceil(task.task_duration_hours * 60);
    
    // Determine chunk size based on preferred work style
    let chunkSizeMinutes = 30; // default 30 minutes
    let breakBetweenChunks = 0; // minutes of break between chunks
    
    if (profile.preferred_work_style === "Short, focused bursts") {
      chunkSizeMinutes = 25; // Pomodoro-style
      breakBetweenChunks = 5;
    } else if (profile.preferred_work_style === "Long, deep sessions") {
      chunkSizeMinutes = 60; // Longer sessions
      breakBetweenChunks = 10;
    }
    
    // Parse preferred study method for custom chunk/break patterns
    if (profile.preferred_study_method) {
      const studyMatch = profile.preferred_study_method.match(/(\d+)[\s-]*(?:min|minute)/i);
      if (studyMatch) {
        const customChunk = parseInt(studyMatch[1]);
        if (customChunk >= 15 && customChunk <= 120) {
          chunkSizeMinutes = customChunk;
        }
      }
      const breakMatch = profile.preferred_study_method.match(/(\d+)[\s-]*(?:min|minute).*break/i);
      if (breakMatch) {
        const customBreak = parseInt(breakMatch[1]);
        if (customBreak >= 0 && customBreak <= 30) {
          breakBetweenChunks = customBreak;
        }
      }
    }
    
    // Adjust for users who have trouble finishing - use smaller chunks
    if (profile.has_trouble_finishing === "Yes, sometimes") {
      chunkSizeMinutes = Math.min(chunkSizeMinutes, 25);
      breakBetweenChunks = Math.max(breakBetweenChunks, 5);
    }
    
    const chunkCount = Math.max(1, Math.ceil(totalMinutes / chunkSizeMinutes));
    const deadline = new Date(`${task.task_deadline}T${task.task_deadline_time}:00`);

    // Avoid scheduling right at the final minute: require completion before deadline
    // Add buffer for procrastinators and those who have trouble finishing
    let bufferMinutes = 30;
    if (profile.is_procrastinator === "yes") {
      bufferMinutes = 60; // Extra buffer for procrastinators
    }
    if (profile.has_trouble_finishing === "Yes, sometimes") {
      bufferMinutes = Math.max(bufferMinutes, 60);
    }
    const latestAllowed = addMinutes(deadline, -bufferMinutes);

     // Determine usable day range within horizon
     let startDayIndex = 0;
     let endDayIndex = slotsByDay.length - 1;
     for (let i = 0; i < slotsByDay.length; i++) {
       const day = slotsByDay[i].date;
       const dayStart = new Date(day.getTime());
       dayStart.setHours(0, 0, 0, 0);
       const dayEnd = new Date(day.getTime());
       dayEnd.setHours(23, 59, 0, 0);
       if (dayEnd < startDate) continue;
       startDayIndex = i;
       break;
     }
     for (let i = 0; i < slotsByDay.length; i++) {
       const day = slotsByDay[i].date;
       const dayEnd = new Date(day.getTime());
       dayEnd.setHours(23, 59, 0, 0);
       if (dayEnd <= latestAllowed) endDayIndex = i;
     }

     if (endDayIndex < startDayIndex) {
       // No days available before deadline; skip to avoid post-deadline scheduling
       return;
     }

     const daysAvailable = Math.max(1, endDayIndex - startDayIndex + 1);
     
     // Determine scheduling strategy based on procrastinator type
     let schedulingStrategy = "balanced"; // balanced, early, distributed, intensive, deadline-proximate
     
     if (profile.is_procrastinator === "yes") {
       if (profile.procrastinator_type === "deadline-driven") {
         // Schedule closer to deadline to create pressure and urgency (they work better under pressure)
         schedulingStrategy = "deadline-proximate";
       } else if (profile.procrastinator_type === "perfectionist" || profile.procrastinator_type === "overwhelmed") {
         // Spread out to reduce pressure
         schedulingStrategy = "distributed";
       } else if (profile.procrastinator_type === "lack-of-motivation") {
         // Group tasks together for momentum
         schedulingStrategy = "intensive";
       } else if (profile.procrastinator_type === "avoidant") {
         // Distribute evenly to avoid avoidance
         schedulingStrategy = "distributed";
       } else if (profile.procrastinator_type === "distraction") {
         // Use intensive grouping to maintain focus
         schedulingStrategy = "intensive";
       }
     }
     
     // Calculate max chunks per day based on strategy
     let maxChunksPerDay;
     if (schedulingStrategy === "early") {
       // Front-load work: allow more chunks early, fewer later
       maxChunksPerDay = Math.max(2, Math.ceil(chunkCount / Math.max(1, daysAvailable - 2)));
     } else if (schedulingStrategy === "deadline-proximate") {
       // Back-load work: allow more chunks later (closer to deadline), fewer earlier
       // This creates pressure and urgency for deadline-driven procrastinators
       maxChunksPerDay = Math.max(2, Math.ceil(chunkCount / Math.max(1, daysAvailable - 2)));
     } else if (schedulingStrategy === "distributed") {
       // Even distribution: limit chunks per day
       maxChunksPerDay = Math.max(1, Math.ceil(chunkCount / daysAvailable));
     } else if (schedulingStrategy === "intensive") {
       // Allow more chunks per day for momentum
       maxChunksPerDay = Math.max(2, Math.ceil(chunkCount / Math.max(1, Math.floor(daysAvailable / 2))));
     } else {
       // Balanced: default behavior
       maxChunksPerDay = Math.max(1, Math.ceil(chunkCount / daysAvailable));
     }

    // Get productive time window
    const productiveRange = PRODUCTIVE_TIME_WINDOWS[profile.most_productive_time] || [9, 17];
    const [prodStart, prodEnd] = productiveRange.map((h) => h * 60);
    
    // Score slots based on personalization
    function scoreSlot(slot, task, dayInfo) {
      let score = 0;
      const priorityWeight = PRIORITY_WEIGHTS[task.task_priority] ?? 4;
      
      // Productive time window scoring
      const insideProductiveWindow = slot.startMinutes >= prodStart && slot.startMinutes < prodEnd;
      if (insideProductiveWindow) {
        score += 10;
        // Higher priority tasks get even more boost in productive time
        if (priorityWeight <= 2) score += 5;
      } else {
        // Lower priority tasks can go outside productive window
        if (priorityWeight >= 3) score += 3;
      }
      
      // Procrastinator-specific adjustments
      if (profile.is_procrastinator === "yes") {
        if (profile.procrastinator_type === "deadline-driven") {
          // Prefer later times closer to deadline to create pressure and urgency
          // Calculate how close this slot is to the deadline (in days)
          const slotDate = new Date(dayInfo.date);
          slotDate.setHours(Math.floor(slot.startMinutes / 60), slot.startMinutes % 60, 0, 0);
          const daysUntilDeadline = (deadline - slotDate) / (1000 * 60 * 60 * 24);
          const totalDaysAvailable = (latestAllowed - startDate) / (1000 * 60 * 60 * 24);
          
          // Give higher scores to slots closer to deadline (but still within buffer)
          // Slots in the last 30% of available time get bonus points
          if (daysUntilDeadline <= totalDaysAvailable * 0.3) {
            score += 8; // Strong preference for deadline-proximate slots
          } else if (daysUntilDeadline <= totalDaysAvailable * 0.5) {
            score += 4; // Moderate preference
          }
          
          // Also prefer later times in the day (afternoon/evening) for urgency
          if (slot.startMinutes >= 14 * 60 && slot.startMinutes < 20 * 60) {
            score += 3;
          }
        } else if (profile.procrastinator_type === "distraction") {
          // Prefer quieter times (early morning or late evening)
          if (slot.startMinutes < 9 * 60 || slot.startMinutes >= 20 * 60) score += 3;
        } else if (profile.procrastinator_type === "perfectionist") {
          // Prefer productive time windows for quality work
          if (insideProductiveWindow) score += 3;
        } else if (profile.procrastinator_type === "overwhelmed") {
          // Prefer morning slots when energy is higher
          if (slot.startMinutes < 12 * 60) score += 4;
        } else if (profile.procrastinator_type === "avoidant") {
          // Prefer structured times to reduce avoidance
          if (slot.startMinutes >= 9 * 60 && slot.startMinutes < 17 * 60) score += 3;
        } else if (profile.procrastinator_type === "lack-of-motivation") {
          // Prefer grouping tasks together for momentum
          score += 2; // Slight boost to encourage scheduling
        }
      }
      
      // Weekend preference based on work style
      const isWeekend = ["Sat", "Sun"].includes(dayInfo.dayName);
      if (isWeekend && profile.preferred_work_style === "Long, deep sessions") {
        // Long session workers can use weekends
        score += 2;
      } else if (!isWeekend && profile.preferred_work_style === "Short, focused bursts") {
        // Short burst workers prefer weekdays
        score += 2;
      }
      
      // Review-preferred slots for review tasks
      if (slot.reviewPreferred && task.task_name.toLowerCase().includes("review")) {
        score += 5;
      }
      
      return score;
    }

    let chunksScheduled = 0;
    let dayIndex = startDayIndex;
    let lastChunkEndTime = null; // Track last chunk end for break spacing
    
    // For deadline-proximate strategy, iterate backwards from deadline to create pressure
    let dayIterator;
    if (schedulingStrategy === "deadline-proximate") {
      // Create array of day indices in reverse order (closest to deadline first)
      dayIterator = [];
      for (let i = endDayIndex; i >= startDayIndex; i--) {
        dayIterator.push(i);
      }
    } else {
      // Normal forward iteration
      dayIterator = [];
      for (let i = startDayIndex; i <= endDayIndex; i++) {
        dayIterator.push(i);
      }
    }

    for (const currentDayIndex of dayIterator) {
      if (chunksScheduled >= chunkCount) break;
      
      const dayInfo = slotsByDay[currentDayIndex];
      const { date, slots } = dayInfo;

      let chunksToday = 0;
      const isWeekend = ["Sat", "Sun"].includes(dayInfo.dayName);

      // Score and sort available slots for this task
      const candidateSlots = slots
        .map(slot => ({
          slot,
          score: scoreSlot(slot, task, dayInfo),
          slotDateTime: new Date(
            `${date.toISOString().slice(0, 10)}T${formatMinutesToTime(slot.startMinutes)}:00`,
          ),
        }))
        .filter(candidate => {
          if (!candidate.slot.available) return false;
          if (candidate.slotDateTime > latestAllowed) return false;
          if (chunksToday >= maxChunksPerDay) return false;
          
          // Enforce break spacing between chunks
          if (lastChunkEndTime && breakBetweenChunks > 0) {
            const minTimeBetween = addMinutes(lastChunkEndTime, breakBetweenChunks);
            if (candidate.slotDateTime < minTimeBetween) return false;
          }
          
          return true;
        })
        .sort((a, b) => b.score - a.score); // Sort by score descending

      // Schedule chunks from best-scored slots
      // Re-check availability on each iteration since slots are marked unavailable as chunks are scheduled
      for (const candidate of candidateSlots) {
        if (chunksToday >= maxChunksPerDay) break;
        if (chunksScheduled >= chunkCount) break;
        
        // Re-check if slot is still available (may have been marked unavailable by previous chunks)
        if (!candidate.slot.available) continue;
        
        // Re-check break spacing (may have changed after previous chunks)
        if (lastChunkEndTime && breakBetweenChunks > 0) {
          const minTimeBetween = addMinutes(lastChunkEndTime, breakBetweenChunks);
          if (candidate.slotDateTime < minTimeBetween) continue;
        }

        const start = new Date(candidate.slotDateTime);
        const end = addMinutes(start, chunkSizeMinutes);
        
        // Mark all slots covered by this chunk as unavailable
        // Calculate how many 30-minute slots this chunk spans
        const slotsNeeded = Math.ceil(chunkSizeMinutes / 30);
        const chunkStartMinutes = candidate.slot.startMinutes;
        const chunkEndMinutes = chunkStartMinutes + chunkSizeMinutes;
        
        slots.forEach(slot => {
          // Mark slot as unavailable if it overlaps with this chunk
          const slotEndMinutes = slot.startMinutes + 30;
          if (slot.startMinutes < chunkEndMinutes && slotEndMinutes > chunkStartMinutes) {
            slot.available = false;
          }
        });
        
        // Check if we need to reserve break time after this chunk
        if (breakBetweenChunks > 0 && chunksScheduled < chunkCount - 1) {
          // Mark break slots as unavailable (but don't create fixed blocks for short breaks)
          const breakStartMinutes = chunkEndMinutes;
          const breakEndMinutes = breakStartMinutes + breakBetweenChunks;
          
          // Mark slots in the break period as temporarily unavailable
          slots.forEach(slot => {
            const slotEndMinutes = slot.startMinutes + 30;
            if (slot.startMinutes < breakEndMinutes && slotEndMinutes > breakStartMinutes) {
              // Only mark as unavailable if it's a short break (5-15 min)
              // Longer breaks should be handled by fixed break times
              if (breakBetweenChunks <= 15) {
                slot.available = false;
              }
            }
          });
        }

        schedule.push({
          kind: "task",
          taskId: task.id,
          taskName: task.task_name,
          priority: task.task_priority,
          category: task.task_category || "study",
          start: start.toISOString(),
          end: end.toISOString(),
          isWeekend,
        });
        
        chunksScheduled++;
        chunksToday++;
        lastChunkEndTime = end;
        
        if (chunksScheduled >= chunkCount) break;
      }
      
      // Reset last chunk time when moving to next day
      const currentIndexInIterator = dayIterator.indexOf(currentDayIndex);
      if (currentIndexInIterator < dayIterator.length - 1) {
        lastChunkEndTime = null;
      }
    }

    if (chunksScheduled < chunkCount) {
      console.warn(
        `Could not fully schedule task "${task.task_name}" before deadline. Scheduled ${chunksScheduled}/${chunkCount} chunks.`,
      );
    }
  });

  // Merge adjacent fixed blocks with the same label and date
  const mergedFixedBlocks = mergeFixedBlocks(fixedBlocks);

  state.schedule = schedule;
  state.fixedBlocks = mergedFixedBlocks;
  saveUserData();
}

// Merge adjacent fixed blocks with the same label and date
function mergeFixedBlocks(fixedBlocks) {
  if (!fixedBlocks || fixedBlocks.length === 0) return [];
  
  // Group by date and label
  const grouped = {};
  fixedBlocks.forEach(block => {
    const dateStr = block.start.slice(0, 10);
    const key = `${dateStr}_${block.label}_${block.category}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(block);
  });
  
  // Merge each group
  const merged = [];
  Object.values(grouped).forEach(group => {
    // Sort by start time
    group.sort((a, b) => a.start.localeCompare(b.start));
    
    // Merge adjacent blocks
    let current = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      const currentEnd = new Date(current.end);
      const nextStart = new Date(next.start);
      
      // If blocks are adjacent (within 1 minute) or overlapping, merge them
      const timeDiff = (nextStart - currentEnd) / (1000 * 60); // minutes
      if (timeDiff <= 1) {
        // Merge: extend current block's end time
        current.end = next.end;
      } else {
        // Not adjacent, save current and start new
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  });
  
  // Sort merged blocks by start time
  return merged.sort((a, b) => a.start.localeCompare(b.start));
}

function applyTimeRangeToSlots(definition, slots, overrides) {
  // definition can be "HH:MM-HH:MM; HH:MM-HH:MM" etc.
  if (!definition) return;
  const parts = definition.split(/[;,]+/);
  parts.forEach((part) => {
    const trimmed = part.trim();
    const m = trimmed.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) return;
    const startMin = parseTimeToMinutes(m[1]);
    const endMin = parseTimeToMinutes(m[2]);
    if (startMin == null || endMin == null) return;
    slots.forEach((slot) => {
      if (slot.startMinutes >= startMin && slot.startMinutes < endMin) {
        Object.assign(slot, overrides);
      }
    });
  });
}

// Create 30-minute fixed blocks for visualization in the calendar
function createFixedBlocksForDay(definition, date, label, category, fixedBlocks) {
  if (!definition) return;
  const parts = definition.split(/[;,]+/);
  parts.forEach((part) => {
    const trimmed = part.trim();
    const m = trimmed.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) return;
    const startMin = parseTimeToMinutes(m[1]);
    const endMin = parseTimeToMinutes(m[2]);
    if (startMin == null || endMin == null) return;
    for (let minute = startMin; minute < endMin; minute += 30) {
      const startTimeStr = formatMinutesToTime(minute);
      const start = new Date(`${date.toISOString().slice(0, 10)}T${startTimeStr}:00`);
      const end = addMinutes(start, 30);
      fixedBlocks.push({
        kind: "fixed",
        label,
        category,
        start: start.toISOString(),
        end: end.toISOString(),
      });
    }
  });
}

// Parse weekend_schedule text into structured definitions:
// Example line: "Saturday 10:00-12:00 soccer" or "Sun 09:00-11:00 family"
function parseWeekendSchedule(text) {
  const result = {
    Saturday: [],
    Sunday: [],
  };
  if (!text) return result;

  const lines = text.split(/\n|;/);
  const dayPatterns = {
    Saturday: /^(saturday|sat)\b/i,
    Sunday: /^(sunday|sun)\b/i,
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    let matchedDay = null;
    let withoutDay = line;

    Object.entries(dayPatterns).forEach(([dayName, regex]) => {
      if (!matchedDay && regex.test(line)) {
        matchedDay = dayName;
        withoutDay = line.replace(regex, "").trim();
      }
    });

    if (!matchedDay) return;

    const timeMatch = withoutDay.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!timeMatch) return;

    const label = withoutDay.replace(timeMatch[0], "").trim();
    result[matchedDay].push({
      range: `${timeMatch[1]}-${timeMatch[2]}`,
      label,
    });
  });

  return result;
}

// ---------- Calendar Rendering ----------

let currentCalendarView = "weekly";

function initCalendarViewToggle() {
  // Remove existing listeners by cloning and replacing elements
  $all(".btn-toggle-view").forEach((btn) => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener("click", () => {
      const view = newBtn.dataset.view;
      currentCalendarView = view;
      $all(".btn-toggle-view").forEach((b) =>
        b.classList.toggle("active", b.dataset.view === view),
      );
      renderSchedule();
    });
  });
}

function renderSchedule() {
  const container = $("#calendarContainer");
  if (!container) return;

  if ((!state.schedule || state.schedule.length === 0) &&
      (!state.fixedBlocks || state.fixedBlocks.length === 0)) {
    container.innerHTML = `
      <div class="calendar-inner">
        <div class="calendar-empty-state">
          <span>🌱</span>
          <div>Your smart schedule will appear here automatically when you add tasks or daily goals.</div>
        </div>
      </div>
    `;
    return;
  }

  if (currentCalendarView === "monthly") {
    renderMonthlyView(container);
  } else {
    renderTimeGridView(container, currentCalendarView);
  }
}

function renderTimeGridView(container, view) {
  const schedule = [...(state.schedule || [])];
  const fixed = [...(state.fixedBlocks || [])];
  const allBlocks = [...fixed, ...schedule].sort((a, b) => a.start.localeCompare(b.start));

  // Guard against empty schedule
  if (allBlocks.length === 0) {
    container.innerHTML = `
      <div class="calendar-inner">
        <div class="calendar-empty-state">
          <span>🌱</span>
          <div>Your smart schedule will appear here automatically when you add tasks or daily goals.</div>
        </div>
      </div>
    `;
    return;
  }

  const inner = document.createElement("div");
  inner.className = "calendar-inner";

  const grid = document.createElement("div");
  grid.className = view === "daily" ? "calendar-grid calendar-grid-daily" : "calendar-grid";

  // Header row
  const headerRow = document.createElement("div");
  headerRow.className = "calendar-header-row";

  const emptyHeader = document.createElement("div");
  emptyHeader.className = "calendar-header-cell";
  emptyHeader.textContent = "";
  headerRow.appendChild(emptyHeader);

  // For daily view, show today (or first day with tasks if today has none)
  // For weekly view, start from the first scheduled task's day
  let base;
  if (view === "daily") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Check if today has any tasks
    const todayStr = today.toISOString().slice(0, 10);
    const hasTodayTasks = allBlocks.some(block => block.start.startsWith(todayStr));
    
    if (hasTodayTasks) {
      base = today;
    } else {
      // Use the first scheduled task's day
  const startDate = new Date(allBlocks[0].start);
      base = new Date(startDate.toISOString().slice(0, 10) + "T00:00:00");
    }
  } else {
    const startDate = new Date(allBlocks[0].start);
    base = new Date(startDate.toISOString().slice(0, 10) + "T00:00:00");
  }

  const daysToRender = view === "daily" ? 1 : 7;
  const dayDates = [];
  for (let i = 0; i < daysToRender; i++) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + i);
    dayDates.push(d);
    const cell = document.createElement("div");
    cell.className = "calendar-header-cell";
    const dayName = DAYS[(d.getDay() + 6) % 7];
    if (view === "daily") {
      // For daily view, show full date
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", 
                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      cell.textContent = `${dayName}, ${monthNames[d.getMonth()]} ${d.getDate()}`;
    } else {
    cell.textContent = `${dayName} ${d.getDate()}`;
    }
    headerRow.appendChild(cell);
  }

  grid.appendChild(headerRow);

  const startHour = 6;
  const endHour = 24;

  // Track which blocks have been rendered to avoid duplicates
  const renderedBlocks = new Set();

  for (let hour = startHour; hour < endHour; hour++) {
    for (let half = 0; half < 2; half++) {
      const minutesOfDay = hour * 60 + half * 30;
      const timeCell = document.createElement("div");
      timeCell.className = "calendar-time-cell";
      timeCell.textContent =
        half === 0 ? `${String(hour).padStart(2, "0")}:00` : "";
      grid.appendChild(timeCell);

      for (let dayIdx = 0; dayIdx < daysToRender; dayIdx++) {
        const dayDate = dayDates[dayIdx].toISOString().slice(0, 10);
        const timeStr = formatMinutesToTime(minutesOfDay);
        const slotStartISO = `${dayDate}T${timeStr}:00`;
        const slotStart = new Date(slotStartISO);
        const slotEnd = addMinutes(slotStart, 30);
        
        const slotCell = document.createElement("div");
        slotCell.className = "calendar-slot-cell";
        slotCell.dataset.slotDate = dayDate;
        slotCell.dataset.slotTime = slotStartISO;
        
        // Make slot cells droppable
        slotCell.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!slotCell.classList.contains("drag-over")) {
            slotCell.classList.add("drag-over");
          }
        });
        
        slotCell.addEventListener("dragleave", (e) => {
          e.preventDefault();
          slotCell.classList.remove("drag-over");
        });
        
        slotCell.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          slotCell.classList.remove("drag-over");
          handleDrop(e, slotCell, slotStartISO, dayDate);
        });

        // Find blocks that overlap with this slot and haven't been rendered yet
        const blocksHere = allBlocks.filter((s) => {
          // Create a unique key for this block to track if it's been rendered
          const blockKey = s.kind === "task" 
            ? `task-${s.taskId}-${s.start}`
            : `fixed-${s.label}-${s.start}-${s.end}`;
          
          // Skip if already rendered
          if (renderedBlocks.has(blockKey)) return false;
          
          // For daily view, ensure the block is on the correct day
          if (view === "daily") {
            const blockDateStr = s.start.slice(0, 10);
            if (blockDateStr !== dayDate) return false;
          }
          
          const blockStart = new Date(s.start);
          const blockEnd = new Date(s.end);
          // Block overlaps if it starts before slot ends and ends after slot starts
          return blockStart < slotEnd && blockEnd > slotStart;
        });
        
        if (blocksHere.length) {
          // Prefer showing task block over fixed if both exist
          const block =
            blocksHere.find((b) => b.kind === "task") ||
            blocksHere[0];

          // Mark this block as rendered using a unique key
          const blockKey = block.kind === "task" 
            ? `task-${block.taskId}-${block.start}`
            : `fixed-${block.label}-${block.start}-${block.end}`;
          renderedBlocks.add(blockKey);

          let blockDiv = document.createElement("div");

          if (block.kind === "fixed") {
            // Calculate actual duration and time range
            const blockStart = new Date(block.start);
            const blockEnd = new Date(block.end);
            const durationMinutes = Math.round((blockEnd - blockStart) / (1000 * 60));
            const durationDisplay = durationMinutes >= 60 
              ? `${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}m` : ''}`
              : `${durationMinutes}m`;
            
            const blockStartTime = formatMinutesToTime(blockStart.getHours() * 60 + blockStart.getMinutes());
            const blockEndTime = formatMinutesToTime(blockEnd.getHours() * 60 + blockEnd.getMinutes());
            const timeRange = `${blockStartTime} - ${blockEndTime}`;
            
            // Calculate how many slots this block spans
            const slotsSpanned = Math.ceil(durationMinutes / 30);
            
            blockDiv.className = "calendar-task-block calendar-task-block-fixed";
            if (slotsSpanned > 1) {
              blockDiv.style.height = `calc(${slotsSpanned * 20}px - ${(slotsSpanned - 1) * 1}px)`;
              blockDiv.style.zIndex = "10";
            }
            blockDiv.innerHTML = `
              <div class="calendar-task-title">${block.label}</div>
              <div class="calendar-task-meta">${timeRange} · ${durationDisplay}</div>
            `;
          } else {
            const task = state.tasks.find((t) => t.id === block.taskId);
            const priority = task?.task_priority || block.priority;
            const category = task?.task_category || block.category || "study";
            const priorityKey = (priority || "").toLowerCase().replace(/[^a-z]+/g, "-");
            const catInfo = getCategoryInfo(category);

            // Calculate actual duration
            const blockStart = new Date(block.start);
            const blockEnd = new Date(block.end);
            const durationMinutes = Math.round((blockEnd - blockStart) / (1000 * 60));
            const durationDisplay = durationMinutes >= 60 
              ? `${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}m` : ''}`
              : `${durationMinutes}m`;

            // Calculate how many slots this block spans and adjust height
            const slotsSpanned = Math.ceil(durationMinutes / 30);
            const blockStartTime = new Date(block.start);
            const blockStartTimeStr = formatMinutesToTime(blockStartTime.getHours() * 60 + blockStartTime.getMinutes());
            
            blockDiv.className = `calendar-task-block category-${category} priority-${priorityKey}`;
            // Apply custom color for goal categories
            if (catInfo.isGoal && catInfo.color) {
              // Convert rgba to use different opacity for gradient
              const bg1 = catInfo.color.bg.replace(/0\.15/g, '0.25');
              const bg2 = catInfo.color.bg.replace(/0\.15/g, '0.15');
              blockDiv.style.background = `linear-gradient(135deg, ${bg1}, ${bg2}) !important`;
              blockDiv.style.borderLeft = `3px solid ${catInfo.color.text}`;
              blockDiv.style.color = catInfo.color.text;
            }
            blockDiv.dataset.taskId = block.taskId;
            blockDiv.dataset.blockStart = block.start;
            blockDiv.dataset.blockEnd = block.end;
            // Calculate height: each slot is ~20px min-height, so multiply by slots spanned
            // Use calc to account for borders and padding
            if (slotsSpanned > 1) {
              blockDiv.style.height = `calc(${slotsSpanned * 20}px - ${(slotsSpanned - 1) * 1}px)`;
              blockDiv.style.zIndex = "10";
            }
            blockDiv.innerHTML = `
              <div class="calendar-task-title">${block.taskName}</div>
              <div class="calendar-task-meta">${blockStartTimeStr} · ${durationDisplay}</div>
            `;
            
            // Make task blocks draggable (not fixed blocks)
            if (block.kind === "task") {
              blockDiv.draggable = true;
              blockDiv.addEventListener("dragstart", (e) => handleDragStart(e, block));
              blockDiv.addEventListener("dragend", handleDragEnd);
            }
          }

          // Only add click handler for non-draggable blocks or handle click separately
          if (block.kind === "fixed") {
          blockDiv.addEventListener("click", () => onCalendarBlockClick(block));
          } else {
            // For draggable task blocks, use mousedown to distinguish from drag
            let isDragging = false;
            let dragStartX = 0;
            let dragStartY = 0;
            
            blockDiv.addEventListener("mousedown", (e) => {
              isDragging = false;
              dragStartX = e.clientX;
              dragStartY = e.clientY;
            });
            
            blockDiv.addEventListener("mousemove", (e) => {
              if (Math.abs(e.clientX - dragStartX) > 5 || Math.abs(e.clientY - dragStartY) > 5) {
                isDragging = true;
              }
            });
            
            blockDiv.addEventListener("click", (e) => {
              // Only trigger click if it wasn't a drag
              if (!isDragging) {
                onCalendarBlockClick(block);
              }
              isDragging = false;
            });
          }
          slotCell.appendChild(blockDiv);
        }

        grid.appendChild(slotCell);
      }
    }
  }

  inner.appendChild(grid);
  
  // Add current time line and current day highlighting
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const currentHour = today.getHours();
  const currentMinute = today.getMinutes();
  const currentMinutesOfDay = currentHour * 60 + currentMinute;
  
  // Highlight current day in header
  dayDates.forEach((dayDate, dayIdx) => {
    const dayStr = dayDate.toISOString().slice(0, 10);
    if (dayStr === todayStr) {
      const headerCell = headerRow.children[dayIdx + 1]; // +1 for time column
      if (headerCell) {
        headerCell.classList.add("calendar-header-cell-today");
      }
      
      // Highlight current day column in grid using data-slotDate filter instead of nth-child
      // The grid structure has time cells and slot cells interleaved, so nth-child won't work correctly
      $all(".calendar-slot-cell").forEach(cell => {
        if (cell.dataset.slotDate === todayStr) {
          cell.classList.add("calendar-slot-cell-today");
        }
      });
    }
  });
  
  // Add current time line (only for today and if within visible hours)
  if (currentMinutesOfDay >= startHour * 60 && currentMinutesOfDay < endHour * 60) {
    const timeLine = document.createElement("div");
    timeLine.className = "calendar-current-time-line";
    const timeLinePosition = ((currentMinutesOfDay - startHour * 60) / 30) * 20; // 20px per 30-min slot
    timeLine.style.top = `${timeLinePosition}px`;
    
    // Find today's column using data-slotDate filter (same approach as highlighting above)
    // The grid structure has time cells and slot cells interleaved, so nth-child won't work correctly
    const todaySlots = $all(".calendar-slot-cell").filter(cell => cell.dataset.slotDate === todayStr);
    if (todaySlots.length > 0) {
      const firstSlot = todaySlots[0];
      const slotRect = firstSlot.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      timeLine.style.left = `${slotRect.left - gridRect.left}px`;
      timeLine.style.width = `${slotRect.width}px`;
      inner.style.position = "relative";
      inner.appendChild(timeLine);
    }
  }
  
  container.innerHTML = "";
  container.appendChild(inner);
}

function renderMonthlyView(container) {
  const schedule = [
    ...(state.fixedBlocks || []),
    ...(state.schedule || []),
  ].sort((a, b) => a.start.localeCompare(b.start));

  // Guard against empty schedule
  if (schedule.length === 0) {
    container.innerHTML = `
      <div class="calendar-inner">
        <div class="calendar-empty-state">
          <span>🌱</span>
          <div>Your smart schedule will appear here automatically when you add tasks or daily goals.</div>
        </div>
      </div>
    `;
    return;
  }

  const inner = document.createElement("div");
  inner.className = "calendar-inner";

  // Month header with month/year
  const monthHeader = document.createElement("div");
  monthHeader.className = "calendar-month-header";
  const first = new Date(schedule[0].start);
  const year = first.getFullYear();
  const month = first.getMonth();
  const monthNames = ["January", "February", "March", "April", "May", "June", 
                      "July", "August", "September", "October", "November", "December"];
  monthHeader.textContent = `${monthNames[month]} ${year}`;
  inner.appendChild(monthHeader);

  const monthGrid = document.createElement("div");
  monthGrid.className = "calendar-month-grid";

  const firstOfMonth = new Date(year, month, 1);
  const startIndex = (firstOfMonth.getDay() + 6) % 7; // Monday-first index

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startIndex + daysInMonth) / 7) * 7;

  const scheduleByDate = schedule.reduce((acc, s) => {
    const day = s.start.slice(0, 10);
    acc[day] = acc[day] || [];
    acc[day].push(s);
    return acc;
  }, {});

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement("div");
    cell.className = "calendar-month-cell";

    const dayNumber = i - startIndex + 1;
    if (dayNumber > 0 && dayNumber <= daysInMonth) {
      const dateStr = new Date(year, month, dayNumber).toISOString().slice(0, 10);
      const dayLabel = document.createElement("div");
      dayLabel.className = "calendar-month-day";
      if (dateStr === todayStr) {
        dayLabel.classList.add("calendar-month-day-today");
      }
      dayLabel.textContent = dayNumber;
      cell.appendChild(dayLabel);

      const dayTasks = scheduleByDate[dateStr] || [];
      if (dayTasks.length > 0) {
        const tasksContainer = document.createElement("div");
        tasksContainer.className = "calendar-month-tasks";
        
        // Show up to 3 tasks, with indicator if more
        const tasksToShow = dayTasks.slice(0, 3);
        tasksToShow.forEach((block) => {
          const taskItem = document.createElement("div");
          taskItem.className = "calendar-month-task-item";
          
          if (block.kind === "task") {
            const task = state.tasks.find((t) => t.id === block.taskId);
            const priority = task?.task_priority || block.priority;
            const category = task?.task_category || block.category || "study";
            const priorityKey = (priority || "").toLowerCase().replace(/[^a-z]+/g, "-");
            const catInfo = getCategoryInfo(category);
            
            taskItem.classList.add("category-" + category);
            taskItem.classList.add("priority-" + priorityKey);
            // Apply custom color for goal categories
            if (catInfo.isGoal && catInfo.color) {
              taskItem.style.background = `linear-gradient(135deg, ${catInfo.color.bg}, ${catInfo.color.bg.replace('0.15', '0.1')})`;
              taskItem.style.borderLeft = `2px solid ${catInfo.color.text}`;
              taskItem.style.color = catInfo.color.text;
            }
            taskItem.textContent = block.taskName || task?.task_name || "Task";
            taskItem.title = `${block.taskName || task?.task_name || "Task"} - ${priority || ""}`;
            taskItem.addEventListener("click", (e) => {
              e.stopPropagation();
              onCalendarBlockClick(block);
            });
          } else {
            taskItem.classList.add("calendar-month-task-fixed");
            const displayLabel = block.label || "Fixed commitment";
            taskItem.textContent = displayLabel;
            // Add time info to tooltip
            const blockStart = new Date(block.start);
            const blockEnd = new Date(block.end);
            const startTime = formatMinutesToTime(blockStart.getHours() * 60 + blockStart.getMinutes());
            const endTime = formatMinutesToTime(blockEnd.getHours() * 60 + blockEnd.getMinutes());
            taskItem.title = `${displayLabel} (${startTime} - ${endTime})`;
          }
          
          tasksContainer.appendChild(taskItem);
        });
        
        if (dayTasks.length > 3) {
          const moreIndicator = document.createElement("div");
          moreIndicator.className = "calendar-month-more";
          moreIndicator.textContent = `+${dayTasks.length - 3} more`;
          tasksContainer.appendChild(moreIndicator);
        }
        
        cell.appendChild(tasksContainer);
      }
    } else {
      // Empty cell for days outside current month
      cell.classList.add("calendar-month-cell-empty");
    }

    monthGrid.appendChild(cell);
  }

  inner.appendChild(monthGrid);
  container.innerHTML = "";
  container.appendChild(inner);
}

// ---------- Calendar Interactions ----------

let countdownInterval = null;
let draggedBlock = null;

function handleDragStart(e, block) {
  if (block.kind !== "task") {
    e.preventDefault();
    return;
  }
  draggedBlock = block;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", block.taskId);
  
  // Add visual feedback
  const blockEl = e.target.closest(".calendar-task-block");
  if (blockEl) {
    blockEl.classList.add("dragging");
    blockEl.style.opacity = "0.5";
  }
}

function handleDragEnd(e) {
  const blockEl = e.target.closest(".calendar-task-block");
  if (blockEl) {
    blockEl.classList.remove("dragging");
    blockEl.style.opacity = "";
  }
  
  // Remove drag-over classes from all slots
  $all(".calendar-slot-cell").forEach(cell => {
    cell.classList.remove("drag-over");
  });
  
  draggedBlock = null;
}

function handleDrop(e, slotCell, slotStartISO, dayDate) {
  if (!draggedBlock || draggedBlock.kind !== "task") return;
  
  const newStart = new Date(slotStartISO);
  const oldStart = new Date(draggedBlock.start);
  const oldEnd = new Date(draggedBlock.end);
  const duration = oldEnd - oldStart; // duration in milliseconds
  const newEnd = new Date(newStart.getTime() + duration);
  
  // Check if the new time conflicts with fixed blocks
  const conflictsWithFixed = state.fixedBlocks.some(fixed => {
    const fixedStart = new Date(fixed.start);
    const fixedEnd = new Date(fixed.end);
    return (newStart < fixedEnd && newEnd > fixedStart);
  });
  
  if (conflictsWithFixed) {
    alert("Cannot move task here - conflicts with a fixed commitment.");
    return;
  }
  
  // Check if the new time conflicts with other scheduled tasks (excluding the one being moved)
  const conflictsWithTasks = state.schedule.some(scheduled => {
    // Skip the task being moved (check by taskId and original start time)
    if (scheduled.kind === "task" && 
        scheduled.taskId === draggedBlock.taskId && 
        scheduled.start === draggedBlock.start) {
      return false;
    }
    
    // Check for overlap with other tasks
    if (scheduled.kind === "task") {
      const scheduledStart = new Date(scheduled.start);
      const scheduledEnd = new Date(scheduled.end);
      return (newStart < scheduledEnd && newEnd > scheduledStart);
    }
    
    return false;
  });
  
  if (conflictsWithTasks) {
    alert("Cannot move task here - conflicts with another scheduled task.");
    return;
  }
  
  // Check if new time is before task deadline
  const task = state.tasks.find(t => t.id === draggedBlock.taskId);
  if (task) {
    const deadline = new Date(`${task.task_deadline}T${task.task_deadline_time}:00`);
    if (newEnd > deadline) {
      alert("Cannot move task here - would be after the deadline.");
      return;
    }
  }
  
  // Update the schedule
  const scheduleIndex = state.schedule.findIndex(s => 
    s.kind === "task" && 
    s.taskId === draggedBlock.taskId && 
    s.start === draggedBlock.start
  );
  
  if (scheduleIndex !== -1) {
    state.schedule[scheduleIndex].start = newStart.toISOString();
    state.schedule[scheduleIndex].end = newEnd.toISOString();
    saveUserData();
    renderSchedule();
    showToast("Task moved successfully!");
  }
}

function onCalendarBlockClick(block) {
  const profile = state.profile;
  if (block.kind === "fixed") {
    alert(
      `Routine: ${block.label}\nTime: ${block.start.slice(11, 16)} - ${block.end.slice(
        11,
        16,
      )}`,
    );
    return;
  }

  if (!block.taskId) return;

  // Open Pomodoro timer for task blocks
  openPomodoroTimer(block.taskId);
}

function startCountdown(block) {
  const overlay = $("#countdownOverlay");
  const nameEl = $("#countdownTaskName");
  const timerEl = $("#countdownTimer");
  const stopBtn = $("#stopCountdownBtn");

  nameEl.textContent = `Stay with: ${block.taskName}`;
  let remaining = 25 * 60; // 25 minutes

  function render() {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  render();
  overlay.classList.remove("hidden");

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      overlay.classList.add("hidden");
      alert("Nice work. This focus block is done — take a short break. 🌟");
      return;
    }
    render();
  }, 1000);

  stopBtn.onclick = () => {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    overlay.classList.add("hidden");
  };
}

// ---------- Chatbot ----------

// Simple markdown parser for chatbot messages
function parseMarkdown(text) {
  if (!text) return "";
  
  // Escape HTML to prevent XSS
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  
  // Use placeholders to avoid conflicts between bold and italic
  const placeholders = [];
  let placeholderIndex = 0;
  
  // First, replace bold **text** with placeholders
  html = html.replace(/\*\*(.+?)\*\*/g, (match, content) => {
    const placeholder = `__BOLDPLACEHOLDER_${placeholderIndex}__`;
    placeholders[placeholderIndex] = `<strong>${content}</strong>`;
    placeholderIndex++;
    return placeholder;
  });
  
  // Then replace bold __text__ with placeholders
  html = html.replace(/__(.+?)__/g, (match, content) => {
    const placeholder = `__BOLDPLACEHOLDER_${placeholderIndex}__`;
    placeholders[placeholderIndex] = `<strong>${content}</strong>`;
    placeholderIndex++;
    return placeholder;
  });
  
  // Then process italic (single asterisk only, underscores are used for bold)
  html = html.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  
  // Restore bold placeholders
  placeholders.forEach((replacement, index) => {
    html = html.replace(`__BOLDPLACEHOLDER_${index}__`, replacement);
  });
  
  // Line breaks: \n to <br>
  html = html.replace(/\n/g, "<br>");
  
  return html;
}

function initChatbot() {
  const chatWindow = $("#chatWindow");
  const chatForm = $("#chatForm");
  const chatInput = $("#chatInput");
  if (!chatWindow || !chatForm || !chatInput) return;

  function addMessage(text, sender) {
    const msg = document.createElement("div");
    msg.className = `chat-message ${sender}`;
    // Parse markdown for bot messages, escape HTML for user messages
    msg.innerHTML = sender === "bot" ? parseMarkdown(text) : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    chatWindow.appendChild(msg);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function initialMessage() {
    addMessage(
      "Hi! I’m your Axis assistant. Tell me how you’re feeling about your workload or ask for help with prioritizing, focus, or breaks.",
      "bot",
    );
  }

  if (!chatWindow.dataset.initialized) {
    chatWindow.dataset.initialized = "true";
    initialMessage();
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    addMessage(text, "user");
    chatInput.value = "";

    generateChatReply(text)
      .then((reply) => addMessage(reply, "bot"))
      .catch((err) => {
        console.warn("Falling back to local reply:", err);
        addMessage(fallbackRuleBasedReply(text), "bot");
      });
  });
}

async function generateChatReply(text) {
  const name = state.profile?.user_name || "friend";

  // Try backend /api/chat first
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: text,
        context: `User: ${name}. Current schedule has ${state.tasks?.length || 0} tasks.`,
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMsg = errorData.error || `API error: ${res.status}`;
      console.error("Chat API error:", errorMsg, errorData);
      
      // Show user-friendly error message for common issues
      if (res.status === 401 || res.status === 500) {
        return `⚠️ API Configuration Issue: ${errorMsg}. Please check your DeepSeek API key in the .env file and restart the server. For now, I'll use a basic response: ${fallbackRuleBasedReply(text)}`;
      }
      
      throw new Error(errorMsg);
    }
    const data = await res.json();
    if (data && typeof data.reply === "string") {
      return data.reply;
    }
    throw new Error("No reply field in API response");
  } catch (err) {
    console.warn("Chat API failed, using local rule-based answers instead.", err);
    return fallbackRuleBasedReply(text);
  }
}

function fallbackRuleBasedReply(text) {
  const lower = text.toLowerCase();
  const name = state.profile?.user_name || "friend";

  if (lower.includes("overwhelmed") || lower.includes("too much")) {
    return `I hear you, ${name}. Let’s tackle this gently: start with the most urgent & important task and aim for one 25‑minute focus block. After that, take a 5‑minute break and reassess — you don’t have to finish everything at once.`;
  }
  if (lower.includes("procrastinate") || lower.includes("motivation")) {
    return `Procrastination usually shows up when a task feels vague or huge. Try rewriting one task as a very concrete 30‑minute action (like “outline intro paragraph” instead of “write essay”), then start the smallest, easiest part. I’ll keep scheduling sessions so future‑you isn’t stressed right before deadlines.`;
  }
  if (lower.includes("break") || lower.includes("rest")) {
    return `Smart breaks keep your brain sharp. After about 25–50 minutes of focused work, step away for 5–10 minutes — move, hydrate, or look away from screens — then come back for another block. I’ll help you preserve your weekly personal time so rest is protected, not optional.`;
  }
  if (lower.includes("focus") || lower.includes("distract")) {
    return `To protect your focus, choose one task block from the calendar and commit to it only for the next 25 minutes. Silence notifications, clear your desk, and keep just what you need for that task visible. If you're deadline-driven, we can use the countdown timer to recreate that urgency early, not at the last minute.`;
  }
  if (lower.includes("schedule") || lower.includes("plan")) {
    return `Your schedule is built around deadlines, priorities, and your productive times. If something feels off, you can tell me which task is stressing you most, and I’ll suggest which block to move or split so your plan feels more humane and still finishes before the deadline.`;
  }

  return `Good question, ${name}. In general: keep your highest‑priority tasks in your most productive time of day, use 30‑minute chunks so nothing feels impossible, and avoid stacking all the hard work right before deadlines. If you tell me which task feels most important today, I can help you choose the best starting point.`;
}

// ---------- Restore ----------

// ---------- Reflection System ----------

// Check reflections periodically using real time (every hour)
let reflectionCheckInterval = null;
let reflectionPromptActive = false; // Track if a reflection prompt is currently showing

function startReflectionChecker() {
  // Clear any existing interval
  if (reflectionCheckInterval) {
    clearInterval(reflectionCheckInterval);
  }
  
  // Don't check immediately on start - only check periodically based on real time
  // This prevents prompts from appearing every time the user opens the website
  
  // Check every hour (3600000 ms) to see if it's time for a reflection
  reflectionCheckInterval = setInterval(() => {
    checkReflectionDue();
  }, 3600000); // 1 hour
}

function stopReflectionChecker() {
  if (reflectionCheckInterval) {
    clearInterval(reflectionCheckInterval);
    reflectionCheckInterval = null;
  }
}

function checkReflectionDue() {
  // Don't check if a prompt is already active
  if (reflectionPromptActive) {
    return;
  }
  
  if (!state.reflections) state.reflections = [];
  
  const now = new Date();
  
  // Check weekly reflection (required every 7 days)
  const lastWeekly = state.reflections
    .filter(r => r.type === "weekly")
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  
  if (lastWeekly) {
    // User has submitted at least one weekly reflection
    // Check if 7 days have passed since the last one
    const lastWeeklyDate = new Date(lastWeekly.date);
    const daysSince = Math.floor((now - lastWeeklyDate) / (1000 * 60 * 60 * 24));
    
    if (daysSince >= 7) {
      // Calculate next due date (7 days from last reflection)
      const nextDueDate = new Date(lastWeeklyDate);
      nextDueDate.setDate(nextDueDate.getDate() + 7);
      
      // Only prompt if we've reached or passed the due date
      if (now >= nextDueDate) {
        showReflectionPrompt("weekly");
        return;
      }
    }
  } else {
    // No weekly reflection yet - check if 7 days have passed since signup
    if (state.firstReflectionDueDate) {
      const dueDate = new Date(state.firstReflectionDueDate);
      // Only prompt if we've reached or passed the due date
      if (now >= dueDate) {
        showReflectionPrompt("weekly");
        return;
      }
    } else {
      // Initialize first reflection due date if it doesn't exist
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7);
      state.firstReflectionDueDate = dueDate.toISOString();
      saveUserData();
    }
  }
  
  // Check monthly reflection (required every 30 days)
  const lastMonthly = state.reflections
    .filter(r => r.type === "monthly")
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  
  if (lastMonthly) {
    // User has submitted at least one monthly reflection
    // Check if 30 days have passed since the last one
    const lastMonthlyDate = new Date(lastMonthly.date);
    const daysSince = Math.floor((now - lastMonthlyDate) / (1000 * 60 * 60 * 24));
    
    if (daysSince >= 30) {
      // Calculate next due date (30 days from last reflection)
      const nextDueDate = new Date(lastMonthlyDate);
      nextDueDate.setDate(nextDueDate.getDate() + 30);
      
      // Only prompt if we've reached or passed the due date
      if (now >= nextDueDate) {
        showReflectionPrompt("monthly");
        return;
      }
    }
  }
  // If no monthly reflection yet, we'll wait until they've done at least one weekly
}

function showReflectionPrompt(type) {
  // Prevent multiple prompts from showing
  if (reflectionPromptActive) {
    return;
  }
  
  const modal = $("#reflectionModal");
  if (!modal) return;
  
  // Mark that a prompt is now active
  reflectionPromptActive = true;
  
  const title = $("#reflectionTitle");
  
  if (title) {
    title.textContent = `${type.charAt(0).toUpperCase() + type.slice(1)} Reflection`;
  }
  
  modal.classList.remove("hidden");
  
  // Handle form submission - remove existing listener first to avoid accumulation
  const form = $("#reflectionForm");
  if (form) {
    // Remove existing listener by cloning and replacing the form
    const newForm = form.cloneNode(true);
    form.parentNode?.replaceChild(newForm, form);
    
    // Update textarea reference since we cloned the form
    const textarea = newForm.querySelector("#reflectionText");
    
    if (textarea) {
      textarea.value = "";
      textarea.placeholder = type === "weekly"
        ? "Reflect on your week: Overall progress, emotional patterns, procrastination triggers, focus levels, what worked and what didn't..."
        : "Reflect on your month: Major achievements, recurring patterns, emotional trends, productivity insights, goals progress...";
    }
    
    const handler = async (e) => {
      e.preventDefault();
      const content = textarea.value.trim();
      if (!content) {
        alert("Please write your reflection.");
        return;
      }
      
      // Save reflection
      const reflection = {
        id: `reflection_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        date: new Date().toISOString(),
        content,
        analysis: null, // Will be filled by AI
      };
      
      if (!state.reflections) state.reflections = [];
      state.reflections.push(reflection);
      
      // Analyze reflection with AI
      try {
        const analysis = await analyzeReflection(content, type);
        reflection.analysis = analysis;
        saveUserData();
      } catch (err) {
        console.error("Error analyzing reflection:", err);
        saveUserData(); // Save anyway
      }
      
      modal.classList.add("hidden");
      reflectionPromptActive = false; // Reset flag when reflection is saved
      
      // Don't immediately check for more reflections - let the periodic checker handle it
    };
    
    newForm.addEventListener("submit", handler);
  }
  
  // Close button - use onclick to replace handler instead of addEventListener to avoid accumulation
  const closeBtn = $("#closeReflectionBtn");
  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.classList.add("hidden");
      reflectionPromptActive = false; // Reset flag when modal is closed
    };
  }
  
  // Modal overlay - use onclick to replace handler
  const overlay = modal.querySelector(".modal-overlay");
  if (overlay) {
    overlay.onclick = () => {
      modal.classList.add("hidden");
      reflectionPromptActive = false; // Reset flag when modal is closed
    };
  }
}

async function analyzeReflection(content, type) {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Analyze this ${type} reflection and provide insights on: 1) Emotional patterns (stress, motivation, satisfaction), 2) Procrastination indicators, 3) Focus/productivity patterns, 4) Suggestions for improvement. Keep it concise (2-3 sentences).\n\nReflection: ${content}`,
        context: `User profile: ${JSON.stringify(state.profile || {})}`,
      }),
    });
    
    if (res.ok) {
      const data = await res.json();
      return data.reply || "Analysis pending.";
    }
    return "Analysis pending.";
  } catch (err) {
    console.error("Error analyzing reflection:", err);
    return "Analysis pending.";
  }
}

function restoreFromState() {
  if (state.profile) {
    restoreProfileToForm();
  }
  
  // Initialize sync button
  const syncBtn = $("#syncCalendarBtn");
  if (syncBtn) {
    // Remove existing listeners by cloning
    const newSyncBtn = syncBtn.cloneNode(true);
    syncBtn.parentNode?.replaceChild(newSyncBtn, syncBtn);
    newSyncBtn.addEventListener("click", () => {
      manualSyncCalendar();
    });
  }
  
  if (state.goals) {
    renderGoals();
    updateCategoryDropdown();
  }
  if (state.tasks?.length) {
    renderTasks();
    renderTaskSummary();
  }
  if (state.rankedTasks?.length) {
    renderRankedPreview();
  }
  if (state.dailyHabits) {
    renderDailyHabits();
  }
  renderSchedule();
  
  // Only show wizard when explicitly in onboarding mode
  if (shouldShowOnboarding && !state.profile) {
    setStep(1); // Show personalization wizard
  } else {
    setStep(null); // Hide wizard, show dashboard
  }
  
  // Start periodic reflection checker (checks every hour)
  startReflectionChecker();
}


