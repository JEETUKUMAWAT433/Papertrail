import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import {
  Activity,
  AlarmClock,
  BarChart3,
  CalendarDays,
  Check,
  Clock3,
  Flame,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Save,
  Square,
  Target,
  Timer,
  Trash2,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { authenticatedFetch, type ClerkTokenGetter } from "./api";

type SessionStatus = "active" | "paused" | "completed";

type StudySession = {
  id: string;
  subject: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  status: SessionStatus;
  notes: string;
};

type Dashboard = {
  today_seconds: number;
  week_seconds: number;
  month_seconds: number;
  daily_average_seconds: number;
  completed_sessions: number;
  current_streak_days: number;
  daily_goal_minutes: number;
  goal_progress_percent: number;
  weekly: Array<{ date: string; seconds: number }>;
  subjects: Array<{ subject: string; seconds: number }>;
};

type PomodoroSettings = {
  enabled: boolean;
  focus_minutes: number;
  break_minutes: number;
  phase: "focus" | "break";
  break_ends_at: string | null;
};

const POMODORO_STORAGE_KEY = "papertrail-study-pomodoro";
const SUBJECT_STORAGE_KEY = "papertrail-study-subjects";
const REMOVED_DEFAULT_SUBJECTS_STORAGE_KEY = "papertrail-removed-default-study-subjects";
const SUBJECTS = [
  "Engineering Mathematics",
  "Introduction to Python",
  "Introduction to Programming with C",
  "Informatics",
  "Python",
  "DSA",
  "Mathematics",
];
const ADD_SUBJECT_OPTION = "Add a subject…";
const CHART_COLORS = ["#42644e", "#7c9a78", "#d29b5b", "#8796a5", "#b47d75", "#9b8cba"];

function initialRemovedDefaultSubjects(storageKey = REMOVED_DEFAULT_SUBJECTS_STORAGE_KEY): string[] {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter(
      (subject): subject is string =>
        typeof subject === "string" && SUBJECTS.includes(subject),
    )));
  } catch {
    return [];
  }
}

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialPomodoroSettings(storageKey = POMODORO_STORAGE_KEY): PomodoroSettings {
  const defaults: PomodoroSettings = {
    enabled: false,
    focus_minutes: 25,
    break_minutes: 5,
    phase: "focus",
    break_ends_at: null,
  };
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return defaults;
    const parsed = JSON.parse(saved) as Partial<PomodoroSettings>;
    if (
      typeof parsed.focus_minutes !== "number" ||
      typeof parsed.break_minutes !== "number"
    ) {
      return defaults;
    }
    return {
      ...defaults,
      ...parsed,
      focus_minutes: Math.min(180, Math.max(1, parsed.focus_minutes)),
      break_minutes: Math.min(60, Math.max(1, parsed.break_minutes)),
      phase: parsed.phase === "break" ? "break" : "focus",
      break_ends_at:
        typeof parsed.break_ends_at === "string" ? parsed.break_ends_at : null,
    };
  } catch {
    return defaults;
  }
}

function initialCustomSubjects(storageKey = SUBJECT_STORAGE_KEY): string[] {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed.filter(
          (subject): subject is string =>
            typeof subject === "string" &&
            subject.trim().length > 0 &&
            subject.trim().length <= 80,
        ).map((subject) => subject.trim()),
      ),
    ).slice(0, 100);
  } catch {
    return [];
  }
}

function formatDuration(seconds: number) {
  const wholeMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function readableDuration(seconds: number) {
  const wholeMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(wholeMinutes / 60);
  const minutes = wholeMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function dateLabel(isoDate: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
    new Date(`${isoDate}T12:00:00`),
  );
}

function sessionDateLabel(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function getTimezoneOffset() {
  return new Date().getTimezoneOffset();
}

async function apiRequest<T>(
  path: string,
  getToken: ClerkTokenGetter,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await authenticatedFetch(path, getToken, init);
  } catch (requestError) {
    if (!(requestError instanceof TypeError)) throw requestError;
    throw new Error(
      "Could not reach the Papertrail API. Make sure the backend is running on port 8000.",
    );
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // Keep the status message when the server does not return JSON.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <article className="rounded-2xl border border-[#e6e7e1] bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#818981]">
          {label}
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#eff3ed] text-[#55705d]">
          <Icon size={16} />
        </span>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-[#29372d]">{value}</p>
      {detail && <p className="mt-1 text-[11px] text-[#8a9089]">{detail}</p>}
    </article>
  );
}

export default function StudyTracker() {
  const { getToken, userId } = useAuth();
  const pomodoroStorageKey = `${POMODORO_STORAGE_KEY}:${userId ?? "anonymous"}`;
  const subjectStorageKey = `${SUBJECT_STORAGE_KEY}:${userId ?? "anonymous"}`;
  const removedDefaultSubjectsStorageKey =
    `${REMOVED_DEFAULT_SUBJECTS_STORAGE_KEY}:${userId ?? "anonymous"}`;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [activeSession, setActiveSession] = useState<StudySession | null>(null);
  const [activeFetchedAt, setActiveFetchedAt] = useState(Date.now());
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [subjectChoice, setSubjectChoice] = useState("Python");
  const [customSubjects, setCustomSubjects] = useState(() =>
    initialCustomSubjects(subjectStorageKey),
  );
  const [removedDefaultSubjects, setRemovedDefaultSubjects] = useState(
    () => initialRemovedDefaultSubjects(removedDefaultSubjectsStorageKey),
  );
  const [newSubject, setNewSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [goalDraft, setGoalDraft] = useState("60");
  const [goalSaving, setGoalSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [pomodoro, setPomodoro] = useState(() => initialPomodoroSettings(pomodoroStorageKey));
  const [historyFrom, setHistoryFrom] = useState(() => {
    const from = new Date();
    from.setDate(from.getDate() - 29);
    return localDateString(from);
  });
  const [historyTo, setHistoryTo] = useState(() => localDateString(new Date()));
  const [historySubject, setHistorySubject] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyInitialized, setHistoryInitialized] = useState(false);
  const handledPomodoroTransition = useRef("");
  const activeRequestVersion = useRef(0);

  const refreshActive = useCallback(async () => {
    if (busy) return;
    const requestVersion = ++activeRequestVersion.current;
    const current = await apiRequest<StudySession | null>("/api/study/active", getToken);
    if (requestVersion === activeRequestVersion.current) {
      setActiveSession(current);
      setActiveFetchedAt(Date.now());
    }
  }, [busy, getToken]);

  const refreshDashboard = useCallback(async () => {
    const params = new URLSearchParams({
      timezone_offset_minutes: String(getTimezoneOffset()),
    });
    const result = await apiRequest<Dashboard>(
      `/api/study/dashboard?${params}`,
      getToken,
    );
    setDashboard(result);
    setGoalDraft(String(result.daily_goal_minutes));
  }, [getToken]);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    const params = new URLSearchParams({
      timezone_offset_minutes: String(getTimezoneOffset()),
    });
    if (historyFrom) params.set("from_date", historyFrom);
    if (historyTo) params.set("to_date", historyTo);
    if (historySubject) params.set("subject", historySubject);
    try {
      const result = await apiRequest<StudySession[]>(
        `/api/study/sessions?${params}`,
        getToken,
      );
      setSessions(result);
      setHistoryInitialized(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load study history.");
    } finally {
      setHistoryLoading(false);
    }
  }, [getToken, historyFrom, historySubject, historyTo]);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshActive(), refreshDashboard()]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the study tracker.");
    } finally {
      setLoading(false);
    }
  }, [refreshActive, refreshDashboard]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void refreshActive().catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : "Could not refresh the active timer.",
        );
      });
      void refreshDashboard().catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : "Could not refresh study statistics.",
        );
      });
    }, 15000);
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshActive, refreshAll, refreshDashboard]);

  useEffect(() => {
    try {
      localStorage.setItem(pomodoroStorageKey, JSON.stringify(pomodoro));
    } catch {
      setError("Browser storage is unavailable; Pomodoro settings may not survive a refresh.");
    }
  }, [pomodoro, pomodoroStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(subjectStorageKey, JSON.stringify(customSubjects));
    } catch {
      setError("Browser storage is unavailable; newly added subjects may not be saved.");
    }
  }, [customSubjects, subjectStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(
        removedDefaultSubjectsStorageKey,
        JSON.stringify(removedDefaultSubjects),
      );
    } catch {
      setError("Browser storage is unavailable; removed subjects may return after a refresh.");
    }
  }, [removedDefaultSubjects, removedDefaultSubjectsStorageKey]);

  const elapsedSeconds = useMemo(() => {
    if (!activeSession) return 0;
    const extraSeconds =
      activeSession.status === "active"
        ? Math.max(0, Math.floor((now - activeFetchedAt) / 1000))
        : 0;
    return activeSession.duration_seconds + extraSeconds;
  }, [activeFetchedAt, activeSession, now]);

  const subjectNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...SUBJECTS,
          ...customSubjects,
          ...sessions.map((session) => session.subject),
        ]),
      ).sort(),
    [customSubjects, sessions],
  );
  const timerSubjectNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...SUBJECTS.filter((subject) => !removedDefaultSubjects.includes(subject)),
          ...customSubjects,
        ]),
      ).sort(),
    [customSubjects, removedDefaultSubjects],
  );

  const runSessionAction = async (action: "pause" | "resume" | "stop") => {
    if (!activeSession || busy) return;
    setBusy(true);
    setError("");
    activeRequestVersion.current += 1;
    try {
      const updated = await apiRequest<StudySession>(
        `/api/study/sessions/${activeSession.id}/${action}`,
        getToken,
        { method: "POST" },
      );
      if (action === "stop") {
        setActiveSession(null);
        setNotes("");
        setPomodoro((current) => ({
          ...current,
          phase: "focus",
          break_ends_at: null,
        }));
        handledPomodoroTransition.current = "";
        await Promise.all([refreshDashboard(), refreshHistory()]);
      } else {
        setActiveSession(updated);
        setActiveFetchedAt(Date.now());
        if (action === "resume" && pomodoro.phase === "break") {
          setPomodoro((current) => ({
            ...current,
            phase: "focus",
            break_ends_at: null,
          }));
          handledPomodoroTransition.current = "";
        }
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Timer update failed.");
    } finally {
      setBusy(false);
    }
  };

  const startSession = async () => {
    if (busy) return;
    const subject = subjectChoice;
    if (!subject) {
      setError("Enter a subject before starting the timer.");
      return;
    }
    setBusy(true);
    setError("");
    activeRequestVersion.current += 1;
    try {
      const session = await apiRequest<StudySession>("/api/study/sessions", getToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, notes }),
      });
      setActiveSession(session);
      setActiveFetchedAt(Date.now());
      handledPomodoroTransition.current = "";
      setPomodoro((current) => ({
        ...current,
        phase: "focus",
        break_ends_at: null,
      }));
      setError("");
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start the timer.");
    } finally {
      setBusy(false);
    }
  };

  const addCustomSubject = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = newSubject.trim();
    if (!subject) {
      setError("Enter a subject name before saving it.");
      return;
    }
    if (subject.length > 80) {
      setError("Subject names must be 80 characters or fewer.");
      return;
    }
    const existing = subjectNames.find(
      (name) => name.toLocaleLowerCase() === subject.toLocaleLowerCase(),
    );
    if (existing) {
      setSubjectChoice(existing);
      setNewSubject("");
      setError("");
      return;
    }
    if (customSubjects.length >= 100) {
      setError("You can save up to 100 custom subjects in this browser.");
      return;
    }
    setCustomSubjects((current) => [...current, subject]);
    setSubjectChoice(subject);
    setNewSubject("");
    setError("");
  };

  const removeSubject = (subject: string) => {
    if (customSubjects.includes(subject)) {
      setCustomSubjects((current) => current.filter((item) => item !== subject));
    } else if (SUBJECTS.includes(subject)) {
      setRemovedDefaultSubjects((current) =>
        current.includes(subject) ? current : [...current, subject],
      );
    } else {
      return;
    }
    if (subjectChoice === subject) {
      const fallback = timerSubjectNames.find((name) => name !== subject);
      setSubjectChoice(fallback ?? ADD_SUBJECT_OPTION);
    }
    setError("");
  };

  const restoreDefaultSubjects = () => {
    setRemovedDefaultSubjects([]);
    if (subjectChoice === ADD_SUBJECT_OPTION) setSubjectChoice("Python");
    setError("");
  };

  useEffect(() => {
    if (!pomodoro.enabled || !activeSession) return;
    if (
      pomodoro.phase === "focus" &&
      activeSession.status === "active" &&
      elapsedSeconds >= pomodoro.focus_minutes * 60
    ) {
      const transitionKey = `${activeSession.id}:focus`;
      if (handledPomodoroTransition.current === transitionKey) return;
      handledPomodoroTransition.current = transitionKey;
      void (async () => {
        try {
          const paused = await apiRequest<StudySession>(
            `/api/study/sessions/${activeSession.id}/pause`,
            getToken,
            { method: "POST" },
          );
          setActiveSession(paused);
          setActiveFetchedAt(Date.now());
          setPomodoro((current) => ({
            ...current,
            phase: "break",
            break_ends_at: new Date(Date.now() + current.break_minutes * 60_000).toISOString(),
          }));
        } catch (transitionError) {
          setError(
            transitionError instanceof Error
              ? transitionError.message
              : "Could not start the Pomodoro break.",
          );
        }
      })();
    } else if (
      pomodoro.phase === "break" &&
      activeSession.status === "paused" &&
      pomodoro.break_ends_at &&
      now >= Date.parse(pomodoro.break_ends_at)
    ) {
      const transitionKey = `${activeSession.id}:break`;
      if (handledPomodoroTransition.current === transitionKey) return;
      handledPomodoroTransition.current = transitionKey;
      void (async () => {
        try {
          const resumed = await apiRequest<StudySession>(
            `/api/study/sessions/${activeSession.id}/resume`,
            getToken,
            { method: "POST" },
          );
          setActiveSession(resumed);
          setActiveFetchedAt(Date.now());
          setPomodoro((current) => ({
            ...current,
            phase: "focus",
            break_ends_at: null,
          }));
          handledPomodoroTransition.current = "";
        } catch (transitionError) {
          setError(
            transitionError instanceof Error
              ? transitionError.message
              : "Could not resume after the Pomodoro break.",
          );
        }
      })();
    }
  }, [activeSession, elapsedSeconds, getToken, now, pomodoro]);

  const saveGoal = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const minutes = Number(goalDraft);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setError("Set a daily goal between 1 and 1440 minutes.");
      return;
    }
    setGoalSaving(true);
    setError("");
    try {
      await apiRequest("/api/study/goal", getToken, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_goal_minutes: minutes }),
      });
      await refreshDashboard();
    } catch (goalError) {
      setError(goalError instanceof Error ? goalError.message : "Could not save your goal.");
    } finally {
      setGoalSaving(false);
    }
  };

  const pomodoroCountdown =
    pomodoro.phase === "break" && pomodoro.break_ends_at
      ? Math.max(0, Math.ceil((Date.parse(pomodoro.break_ends_at) - now) / 1000))
      : Math.max(0, pomodoro.focus_minutes * 60 - elapsedSeconds);

  const chartWeekly = dashboard?.weekly.map((day) => ({
    ...day,
    label: dateLabel(day.date),
    hours: Number((day.seconds / 3600).toFixed(2)),
  }));
  const historySubjectOptions = Array.from(
    new Set([...SUBJECTS, ...subjectNames]),
  ).sort();

  if (loading && !dashboard) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[#778078]">
        <LoaderCircle className="animate-spin" size={18} />
        Loading your study dashboard…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.17em] text-[#6f8173]">
            <Activity size={14} />
            Study smarter
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.05em] sm:text-[40px]">
            Study hours
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#757b74]">
            Track focused time, build a streak, and see where your study hours go.
          </p>
        </div>
        <div className="rounded-xl border border-[#e5e6df] bg-white px-4 py-2.5 text-xs text-[#737b72]">
          <span className="font-semibold text-[#355440]">Saved automatically</span>
          <span className="px-1.5">·</span>
          Timer survives refreshes
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded-xl border border-[#f0d5cc] bg-[#fff6f2] px-4 py-3 text-sm text-[#9b4937]"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            className="text-xs font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard icon={Clock3} label="Today" value={readableDuration(dashboard?.today_seconds ?? 0)} />
        <StatCard icon={CalendarDays} label="This week" value={readableDuration(dashboard?.week_seconds ?? 0)} />
        <StatCard icon={BarChart3} label="This month" value={readableDuration(dashboard?.month_seconds ?? 0)} />
        <StatCard icon={Activity} label="Daily average" value={readableDuration(dashboard?.daily_average_seconds ?? 0)} detail="Month to date" />
        <StatCard icon={Check} label="Completed sessions" value={String(dashboard?.completed_sessions ?? 0)} detail="All time" />
        <StatCard icon={Flame} label="Current streak" value={`${dashboard?.current_streak_days ?? 0} days`} detail="Consecutive days with study time" />
      </section>

      <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <article className="rounded-[22px] border border-[#e6e7e1] bg-white p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Timer size={17} className="text-[#55705d]" />
                Focus timer
              </div>
              <p className="mt-1 text-xs text-[#858b83]">
                {activeSession
                  ? `${activeSession.subject} · ${activeSession.status === "paused" ? "Paused" : "In progress"}`
                  : "Choose a subject and start a study session."}
              </p>
            </div>
            {pomodoro.enabled && (
              <span className="rounded-full bg-[#f4f0e8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8a6b3f]">
                {pomodoro.phase === "break" ? "Break time" : "Focus session"}
              </span>
            )}
          </div>

          <div className="my-7 text-center">
            <p className="font-mono text-6xl font-semibold tracking-[-0.06em] text-[#294c3d] sm:text-7xl">
              {formatDuration(elapsedSeconds)}
            </p>
            <p className="mt-2 text-[11px] text-[#969c94]">HH:MM elapsed</p>
            {pomodoro.enabled && (
              <p className="mt-2 text-xs font-medium text-[#7e735f]">
                {pomodoro.phase === "break" ? "Break ends in " : "Next break in "}
                {formatDuration(pomodoroCountdown)}
              </p>
            )}
          </div>

          {!activeSession ? (
            <div className="mx-auto max-w-lg space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-[11px] font-medium text-[#737b72]">
                  Subject
                  <select
                    value={subjectChoice}
                    onChange={(event) => {
                      setSubjectChoice(event.target.value);
                      setError("");
                    }}
                    className="w-full rounded-lg border border-[#e8ebe6] bg-white px-3 py-2.5 text-xs text-[#434b43] outline-none focus:border-[#9eafa2]"
                  >
                    {timerSubjectNames.map((subject) => (
                      <option key={subject}>{subject}</option>
                    ))}
                    <option>{ADD_SUBJECT_OPTION}</option>
                  </select>
                </label>
                <p className="self-end pb-2 text-[10px] leading-4 text-[#929890]">
                  Use the remove buttons below to hide subjects from this picker.
                </p>
              </div>
              {subjectChoice === ADD_SUBJECT_OPTION && (
                <form onSubmit={addCustomSubject} className="flex gap-2">
                  <label className="sr-only" htmlFor="new-study-subject">
                    New subject name
                  </label>
                  <input
                    id="new-study-subject"
                    value={newSubject}
                    onChange={(event) => setNewSubject(event.target.value)}
                    maxLength={80}
                    placeholder="e.g. Data Structures or Biology"
                    className="min-w-0 flex-1 rounded-lg border border-[#e8ebe6] px-3 py-2.5 text-xs outline-none focus:border-[#9eafa2]"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!newSubject.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#dfe5dd] px-3 py-2 text-xs font-semibold text-[#526654] hover:bg-[#f2f5f0] disabled:opacity-50"
                  >
                    <Plus size={14} />
                    Add subject
                  </button>
                </form>
              )}
              {timerSubjectNames.length > 0 && (
                <div className="space-y-2 rounded-xl border border-[#e8ebe6] bg-[#fbfcfa] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#737b72]">
                    Manage timer subjects
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {timerSubjectNames.map((subject) => (
                      <div
                        key={subject}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#e8ebe6] bg-white pl-2.5 text-xs text-[#434b43]"
                      >
                        <span>{subject}</span>
                        <button
                          type="button"
                          onClick={() => removeSubject(subject)}
                          aria-label={`Remove ${subject} from saved subjects`}
                          title="Remove this subject from the timer picker. Past study sessions will be kept."
                          className="rounded-r-lg p-2 text-[#9b4937] transition hover:bg-[#fff6f2]"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {removedDefaultSubjects.length > 0 && (
                    <button
                      type="button"
                      onClick={restoreDefaultSubjects}
                      className="text-[10px] font-semibold text-[#526654] underline underline-offset-2"
                    >
                      Restore default subjects
                    </button>
                  )}
                </div>
              )}
              <label className="block space-y-1.5 text-[11px] font-medium text-[#737b72]">
                Session notes <span className="font-normal">(optional)</span>
                <input
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={2000}
                  placeholder="What are you working on?"
                  className="w-full rounded-lg border border-[#e8ebe6] px-3 py-2.5 text-xs outline-none focus:border-[#9eafa2]"
                />
              </label>
              <button
                type="button"
                onClick={() => void startSession()}
                disabled={busy || subjectChoice === ADD_SUBJECT_OPTION}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#294c3d] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#1f3d30] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={16} />}
                Start studying
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-center gap-2">
              {activeSession.status === "active" ? (
                <button
                  type="button"
                  onClick={() => void runSessionAction("pause")}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#dfe5dd] px-5 py-2.5 text-sm font-semibold text-[#526654] hover:bg-[#f2f5f0] disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Pause size={16} />}
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void runSessionAction("resume")}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#294c3d] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1f3d30] disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}
                  {pomodoro.phase === "break" ? "Skip break" : "Resume"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void runSessionAction("stop")}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl border border-[#f0d5cc] px-5 py-2.5 text-sm font-semibold text-[#9b4937] hover:bg-[#fff6f2] disabled:opacity-50"
              >
                <Square size={15} />
                Stop & save
              </button>
            </div>
          )}

          <div className="mt-6 border-t border-[#eeefeb] pt-4">
            <label className="flex flex-wrap items-center justify-between gap-3 text-xs font-medium text-[#626c62]">
              <span className="flex items-center gap-2">
                <AlarmClock size={15} />
                Pomodoro mode
              </span>
              <input
                type="checkbox"
                checked={pomodoro.enabled}
                onChange={(event) =>
                  setPomodoro((current) => ({
                    ...current,
                    enabled: event.target.checked,
                    phase: "focus",
                    break_ends_at: null,
                  }))
                }
                className="h-4 w-4 accent-[#42644e]"
              />
            </label>
            {pomodoro.enabled && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-[10px] text-[#858b83]">
                  Study minutes (1–180)
                  <input
                    type="number"
                    min={1}
                    max={180}
                    value={pomodoro.focus_minutes}
                    onChange={(event) =>
                      setPomodoro((current) => ({
                        ...current,
                        focus_minutes: Math.min(180, Math.max(1, Number(event.target.value) || 1)),
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-[#e8ebe6] px-3 py-2 text-xs text-[#434b43]"
                  />
                </label>
                <label className="text-[10px] text-[#858b83]">
                  Break minutes (1–60)
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={pomodoro.break_minutes}
                    onChange={(event) =>
                      setPomodoro((current) => ({
                        ...current,
                        break_minutes: Math.min(60, Math.max(1, Number(event.target.value) || 1)),
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-[#e8ebe6] px-3 py-2 text-xs text-[#434b43]"
                  />
                </label>
              </div>
            )}
            {pomodoro.enabled && (
              <p className="mt-2 text-[10px] leading-4 text-[#90968e]">
                The timer pauses automatically for breaks and resumes when the break ends. Settings and break countdown are saved in this browser.
              </p>
            )}
          </div>
        </article>

        <article className="rounded-[22px] border border-[#e6e7e1] bg-white p-5 sm:p-7">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Target size={17} className="text-[#55705d]" />
            Daily study goal
          </div>
          <p className="mt-1 text-xs text-[#858b83]">
            Set a target and track today’s progress.
          </p>
          <div className="mt-6 flex items-end justify-between gap-3">
            <p className="text-3xl font-semibold tracking-tight text-[#294c3d]">
              {dashboard?.goal_progress_percent ?? 0}%
            </p>
            <p className="pb-1 text-xs text-[#858b83]">
              {readableDuration(dashboard?.today_seconds ?? 0)} of{" "}
              {readableDuration((dashboard?.daily_goal_minutes ?? 60) * 60)}
            </p>
          </div>
          <div
            className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#edf0eb]"
            role="progressbar"
            aria-valuenow={dashboard?.goal_progress_percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Daily study goal progress"
          >
            <div
              className="h-full rounded-full bg-[#66866d] transition-all"
              style={{ width: `${dashboard?.goal_progress_percent ?? 0}%` }}
            />
          </div>
          <form onSubmit={(event) => void saveGoal(event)} className="mt-5 flex gap-2">
            <label className="sr-only" htmlFor="daily-goal">
              Daily goal in minutes
            </label>
            <input
              id="daily-goal"
              type="number"
              min={1}
              max={1440}
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[#e8ebe6] px-3 py-2 text-xs outline-none focus:border-[#9eafa2]"
            />
            <button
              type="submit"
              disabled={goalSaving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#dfe5dd] px-3 py-2 text-xs font-semibold text-[#526654] hover:bg-[#f2f5f0] disabled:opacity-50"
            >
              {goalSaving ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />}
              Save goal
            </button>
          </form>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <article className="rounded-[22px] border border-[#e6e7e1] bg-white p-5 sm:p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold">Last 7 days</h2>
            <p className="mt-1 text-[11px] text-[#858b83]">Daily tracked study time</p>
          </div>
          <div className="h-[250px] w-full">
            {chartWeekly ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartWeekly} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#eef0eb" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#858b83", fontSize: 11 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: "#858b83", fontSize: 10 }} />
                  <Tooltip formatter={(value) => [`${value} hours`, "Study time"]} />
                  <Bar dataKey="hours" fill="#66866d" radius={[6, 6, 0, 0]} maxBarSize={38} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[#8a9089]">Loading chart…</div>
            )}
          </div>
        </article>

        <article className="rounded-[22px] border border-[#e6e7e1] bg-white p-5 sm:p-6">
          <div className="mb-4">
            <h2 className="text-sm font-semibold">Time by subject</h2>
            <p className="mt-1 text-[11px] text-[#858b83]">This month · based on saved timer sessions</p>
          </div>
          {dashboard?.subjects.length ? (
            <div className="grid items-center gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="h-[230px] min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={dashboard.subjects} dataKey="seconds" nameKey="subject" innerRadius={55} outerRadius={90} paddingAngle={3}>
                      {dashboard.subjects.map((entry, index) => (
                        <Cell key={entry.subject} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => [readableDuration(Number(value)), "Study time"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="space-y-2">
                {dashboard.subjects.map((subject, index) => (
                  <li key={subject.subject} className="flex items-center justify-between gap-3 text-xs">
                    <span className="flex min-w-0 items-center gap-2 text-[#606a60]">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
                      <span className="truncate">{subject.subject}</span>
                    </span>
                    <span className="shrink-0 font-semibold text-[#39463b]">{readableDuration(subject.seconds)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex h-[230px] items-center justify-center rounded-xl bg-[#fafbf9] px-5 text-center text-xs leading-5 text-[#8a9089]">
              Your subject breakdown will appear after you save study sessions.
            </div>
          )}
        </article>
      </section>

      <section className="overflow-hidden rounded-[22px] border border-[#e6e7e1] bg-white">
        <div className="border-b border-[#eeefeb] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Study history</h2>
              <p className="mt-1 text-[11px] text-[#858b83]">Completed sessions, filtered by date and subject</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="text-[10px] text-[#858b83]">
                From
                <input type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} className="ml-1 rounded-md border border-[#e8ebe6] px-2 py-1.5 text-[11px] text-[#434b43]" />
              </label>
              <label className="text-[10px] text-[#858b83]">
                To
                <input type="date" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} className="ml-1 rounded-md border border-[#e8ebe6] px-2 py-1.5 text-[11px] text-[#434b43]" />
              </label>
              <label className="text-[10px] text-[#858b83]">
                Subject
                <select value={historySubject} onChange={(event) => setHistorySubject(event.target.value)} className="ml-1 rounded-md border border-[#e8ebe6] bg-white px-2 py-1.5 text-[11px] text-[#434b43]">
                  <option value="">All subjects</option>
                  {historySubjectOptions.map((subject) => <option key={subject}>{subject}</option>)}
                </select>
              </label>
            </div>
          </div>
        </div>
        {historyLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#828980]">
            <LoaderCircle className="animate-spin" size={16} />
            Loading session history…
          </div>
        ) : sessions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="bg-[#fafbf9] text-[10px] uppercase tracking-[0.1em] text-[#858b83]">
                <tr>
                  <th className="px-5 py-3 font-semibold">Date</th>
                  <th className="px-5 py-3 font-semibold">Subject</th>
                  <th className="px-5 py-3 font-semibold">Duration</th>
                  <th className="px-5 py-3 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eeefeb]">
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="whitespace-nowrap px-5 py-3.5 text-[#687268]">{sessionDateLabel(session.start_time)}</td>
                    <td className="px-5 py-3.5 font-medium text-[#39463b]">{session.subject}</td>
                    <td className="px-5 py-3.5 font-semibold text-[#526654]">{formatDuration(session.duration_seconds)}</td>
                    <td className="max-w-[260px] truncate px-5 py-3.5 text-[#858b83]">{session.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-10 text-center text-xs text-[#8a9089]">
            {historyInitialized ? "No saved sessions match these filters yet." : "Start a timer to build your study history."}
          </div>
        )}
      </section>

      <p className="text-center text-[10px] text-[#9a9f97]">
        Study sessions and daily goals are stored in the local Papertrail database.
      </p>
    </div>
  );
}
