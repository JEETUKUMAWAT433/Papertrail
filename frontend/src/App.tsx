import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Files,
  LoaderCircle,
  MessageCircle,
  Search,
  Send,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/react";
import { authenticatedFetch } from "./api";
const StudyTracker = lazy(() => import("./StudyTracker"));

const MAX_FILE_SIZE = 20 * 1024 * 1024;

type DocumentSummary = {
  id: string;
  filename: string;
  file_size: number;
  page_count: number;
  uploaded_at: string;
  character_count: number;
  text_preview: string;
  index_status: "ready" | "pending" | "no_text";
};

type DocumentDetail = DocumentSummary & {
  extracted_text: string;
};

type ChatSource = {
  source_id: string;
  filename: string;
  page_number: number;
  excerpt: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
};

type ChatTurn = Pick<ChatMessage, "role" | "content">;

type StudyLanguage = "en" | "hi";

type DocumentSummaryResult = {
  summary: string;
  language: StudyLanguage;
  source_pages: number[];
};

type ExplanationResult = {
  explanation: string;
  language: StudyLanguage;
  sources: ChatSource[];
};

type QuizQuestion = {
  question: string;
  options: string[];
  page_number: number;
};

type GeneratedQuiz = {
  quiz_id: string;
  language: StudyLanguage;
  questions: QuizQuestion[];
};

type QuizHistoryEntry = {
  quiz_id: string;
  language: StudyLanguage;
  total: number;
  score: number | null;
  submitted: boolean;
  created_at: string;
  questions: QuizQuestion[];
};

type QuizGrade = {
  quiz_id: string;
  score: number;
  total: number;
  correct_count: number;
  results: Array<{
    question: string;
    options: string[];
    selected_index: number;
    correct_index: number;
    is_correct: boolean;
    explanation: string;
    page_number: number;
  }>;
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as { detail?: string };
    return body.detail ?? `Request failed (${response.status}).`;
  } catch {
    if (response.status === 502) {
      return "The Papertrail API is not responding. Start the backend from the project/backend folder with `uvicorn app.main:app --reload`, then try again.";
    }
    return `Request failed (${response.status}).`;
  }
}

function AuthenticatedApp() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const displayName = user?.firstName?.trim() || user?.username || "Student";
  const apiFetch = useCallback(
    (path: string, init?: RequestInit) => authenticatedFetch(path, getToken, init),
    [getToken],
  );
  const [activeView, setActiveView] = useState<"library" | "tracker">("library");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"text" | "chat" | "study">("text");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatConfigured, setChatConfigured] = useState<boolean | null>(null);
  const [studyLanguage, setStudyLanguage] = useState<StudyLanguage>("en");
  const [summaryResult, setSummaryResult] = useState<DocumentSummaryResult | null>(null);
  const [explanationResult, setExplanationResult] = useState<ExplanationResult | null>(null);
  const [explanationInput, setExplanationInput] = useState("");
  const [studyBusy, setStudyBusy] = useState(false);
  const [generatedQuiz, setGeneratedQuiz] = useState<GeneratedQuiz | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [quizGrade, setQuizGrade] = useState<QuizGrade | null>(null);
  const [quizHistory, setQuizHistory] = useState<QuizHistoryEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadDocuments = useCallback(async () => {
    setLoadingList(true);
    try {
      const response = await apiFetch("/api/documents");
      if (!response.ok) throw new Error(await responseError(response));
      setDocuments((await response.json()) as DocumentSummary[]);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load your documents. Is the API running?",
      );
    } finally {
      setLoadingList(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadDocuments();
    void apiFetch("/api/chat/status")
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return (await response.json()) as { configured: boolean };
      })
      .then((status) => setChatConfigured(status.configured))
      .catch(() => setChatConfigured(null));
  }, [apiFetch, loadDocuments]);

  const openDocument = async (document: DocumentSummary) => {
    setSelected(null);
    setChatMessages([]);
    setActiveTab("text");
    setSummaryResult(null);
    setExplanationResult(null);
    setExplanationInput("");
    setGeneratedQuiz(null);
    setQuizAnswers([]);
    setQuizGrade(null);
    setQuizHistory([]);
    setError("");
    try {
      const response = await apiFetch(`/api/documents/${document.id}`);
      if (!response.ok) throw new Error(await responseError(response));
      setSelected((await response.json()) as DocumentDetail);
      const historyResponse = await apiFetch(`/api/documents/${document.id}/quizzes`);
      if (historyResponse.ok) {
        setQuizHistory((await historyResponse.json()) as QuizHistoryEntry[]);
      }
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : "Could not open this document.",
      );
    }
  };

  const downloadOriginal = async () => {
    if (!selected) return;
    try {
      const response = await apiFetch(`/api/documents/${selected.id}/file`);
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = selected.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Could not download the original PDF.",
      );
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatBusy]);

  const sendChatMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !chatInput.trim() || chatBusy) return;

    const question = chatInput.trim();
    const history: ChatTurn[] = chatMessages.slice(-8).map(({ role, content }) => ({
      role,
      content,
    }));
    setChatMessages((messages) => [...messages, { role: "user", content: question }]);
    setChatInput("");
    setChatBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/documents/${selected.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as {
        answer: string;
        sources: ChatSource[];
      };
      setChatMessages((messages) => [
        ...messages,
        { role: "assistant", content: result.answer, sources: result.sources },
      ]);
    } catch (chatError) {
      setChatMessages((messages) => [
        ...messages,
        {
          role: "assistant",
          content:
            chatError instanceof Error
              ? chatError.message
              : "The answer could not be generated. Please try again.",
        },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  const createSummary = async () => {
    if (!selected || studyBusy) return;
    setStudyBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/documents/${selected.id}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: studyLanguage }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setSummaryResult((await response.json()) as DocumentSummaryResult);
    } catch (studyError) {
      setError(studyError instanceof Error ? studyError.message : "Summary generation failed.");
    } finally {
      setStudyBusy(false);
    }
  };

  const explainTopic = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !explanationInput.trim() || studyBusy) return;
    setStudyBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/documents/${selected.id}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: explanationInput.trim(),
          language: studyLanguage,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setExplanationResult((await response.json()) as ExplanationResult);
    } catch (studyError) {
      setError(
        studyError instanceof Error ? studyError.message : "Explanation generation failed.",
      );
    } finally {
      setStudyBusy(false);
    }
  };

  const createQuiz = async () => {
    if (!selected || studyBusy) return;
    setStudyBusy(true);
    setError("");
    setQuizGrade(null);
    try {
      const response = await apiFetch(`/api/documents/${selected.id}/quizzes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: studyLanguage, count: 5 }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const quiz = (await response.json()) as GeneratedQuiz;
      setGeneratedQuiz(quiz);
      setQuizAnswers(Array(quiz.questions.length).fill(-1) as number[]);
      const historyResponse = await apiFetch(`/api/documents/${selected.id}/quizzes`);
      if (historyResponse.ok) {
        setQuizHistory((await historyResponse.json()) as QuizHistoryEntry[]);
      }
    } catch (studyError) {
      setError(studyError instanceof Error ? studyError.message : "Quiz generation failed.");
    } finally {
      setStudyBusy(false);
    }
  };

  const submitQuiz = async () => {
    if (
      !selected ||
      !generatedQuiz ||
      studyBusy ||
      quizAnswers.some((answer) => answer < 0)
    ) {
      return;
    }
    setStudyBusy(true);
    setError("");
    try {
      const response = await apiFetch(
        `/api/documents/${selected.id}/quizzes/${generatedQuiz.quiz_id}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: quizAnswers }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      setQuizGrade((await response.json()) as QuizGrade);
      const historyResponse = await apiFetch(`/api/documents/${selected.id}/quizzes`);
      if (historyResponse.ok) {
        setQuizHistory((await historyResponse.json()) as QuizHistoryEntry[]);
      }
    } catch (studyError) {
      setError(studyError instanceof Error ? studyError.message : "Quiz grading failed.");
    } finally {
      setStudyBusy(false);
    }
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    setError("");
    setNotice("");
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file to continue.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError("This file is over the 20 MB upload limit.");
      return;
    }
    if (file.size === 0) {
      setError("This file is empty. Choose a different PDF.");
      return;
    }
    const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (!new TextDecoder().decode(header).includes("%PDF-")) {
      setError("This file does not appear to be a valid PDF.");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await apiFetch("/api/documents", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const added = (await response.json()) as DocumentSummary;
      await loadDocuments();
      await openDocument(added);
      if (added.index_status === "pending") {
        setNotice(
          "Your PDF was saved, but AI search indexing is pending. You can read its extracted text now; try AI questions again after the provider is available.",
        );
      }
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Upload failed. Please try again.",
      );
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const filteredDocuments = documents.filter((document) =>
    document.filename.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="min-h-screen bg-[#f7f7f4] text-[#20231f]">
      <header className="border-b border-[#e7e8e2] bg-[#fbfbf9]">
        <div className="mx-auto flex h-[74px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="/" className="flex items-center gap-3" aria-label="Papertrail home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#294c3d] text-white">
              <Files size={18} strokeWidth={1.9} />
            </span>
            <span className="text-[17px] font-semibold tracking-[-0.04em]">papertrail</span>
            <span className="hidden rounded-full bg-[#eef1eb] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#557060] sm:inline">
              workspace
            </span>
          </a>
          <div className="flex items-center gap-1 rounded-xl bg-[#f0f2ed] p-1">
            <button
              type="button"
              onClick={() => setActiveView("library")}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                activeView === "library"
                  ? "bg-white text-[#355440] shadow-sm"
                  : "text-[#778078] hover:text-[#4b574d]"
              }`}
            >
              Library
            </button>
            <button
              type="button"
              onClick={() => setActiveView("tracker")}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                activeView === "tracker"
                  ? "bg-white text-[#355440] shadow-sm"
                  : "text-[#778078] hover:text-[#4b574d]"
              }`}
            >
              Study hours
            </button>
          </div>
          <p className="hidden max-w-36 truncate text-xs font-medium text-[#737b72] lg:block">
            {displayName}
          </p>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 pb-16 pt-9 sm:px-8 sm:pt-12 lg:px-12">
        <p className="mb-5 text-sm font-medium text-[#737b72]">
          Welcome back, {displayName}
        </p>
        {activeView === "tracker" ? (
          <Suspense
            fallback={
              <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[#778078]">
                <LoaderCircle className="animate-spin" size={18} />
                Loading study dashboard…
              </div>
            }
          >
            <StudyTracker />
          </Suspense>
        ) : (
          <>
        <section className="mb-9 flex flex-col justify-between gap-6 sm:mb-11 sm:flex-row sm:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.17em] text-[#6f8173]">
              <Sparkles size={13} />
              Your reading room
            </div>
            <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.055em] sm:text-[42px]">
              Documents, made <span className="font-serif font-normal italic">readable.</span>
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#757b74] sm:text-[15px]">
              Drop in a PDF. We’ll pull out the text and keep everything in one calm place.
            </p>
          </div>
          <div className="flex gap-3">
            <div className="rounded-2xl border border-[#e5e6df] bg-white px-4 py-3">
              <div className="text-xl font-semibold tracking-tight">{documents.length}</div>
              <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#858b83]">
                {documents.length === 1 ? "document" : "documents"}
              </div>
            </div>
            <div className="rounded-2xl border border-[#e5e6df] bg-white px-4 py-3">
              <div className="text-xl font-semibold tracking-tight">20 MB</div>
              <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#858b83]">
                max file size
              </div>
            </div>
          </div>
        </section>

        <section
          className={`relative mb-7 overflow-hidden rounded-[24px] border border-dashed p-5 transition-colors sm:p-7 ${
            dragging
              ? "border-[#50745f] bg-[#eef3ed]"
              : "border-[#cbd2c8] bg-[#f0f2ed]"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void uploadFile(event.dataTransfer.files[0]);
          }}
        >
          <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white text-[#42644e] shadow-sm">
                {uploading ? (
                  <LoaderCircle className="animate-spin" size={21} />
                ) : (
                  <Upload size={20} strokeWidth={1.8} />
                )}
              </div>
              <div>
                <div className="text-sm font-semibold">
                  {uploading ? "Reading your PDF…" : "Add a PDF to your library"}
                </div>
                <p className="mt-1 text-xs leading-5 text-[#798078]">
                  Drop a file here or browse your device. PDF only, up to 20 MB.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#294c3d] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#1f3d30] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "Choose a PDF"}
              <ArrowUpRight size={14} />
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            aria-label="Choose a PDF to upload"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void uploadFile(file);
            }}
          />
        </section>

        {error && (
          <div
            role="alert"
            className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-[#f0d5cc] bg-[#fff6f2] px-4 py-3 text-sm text-[#9b4937]"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              className="shrink-0 rounded p-0.5 hover:bg-[#f8e9e4]"
              aria-label="Dismiss error"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-[#ece6d4] bg-[#fbf8ef] px-4 py-3 text-sm text-[#766b4f]"
          >
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              className="shrink-0 rounded p-0.5 hover:bg-[#f2eddc]"
              aria-label="Dismiss notice"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(320px,0.86fr)_minmax(0,1.14fr)]">
          <section className="rounded-[22px] border border-[#e6e7e1] bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-[#eeefeb] px-5 py-4 sm:px-6">
              <div>
                <h2 className="text-sm font-semibold tracking-[-0.02em]">Your documents</h2>
                <p className="mt-1 text-[11px] text-[#8a9089]">
                  {documents.length} {documents.length === 1 ? "file" : "files"} in your library
                </p>
              </div>
              <label className="flex h-9 w-[160px] items-center gap-2 rounded-lg border border-[#eceee9] bg-[#fbfbfa] px-2.5 text-[#91968e] focus-within:border-[#9eafa2]">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a file"
                  aria-label="Find a document"
                  className="min-w-0 bg-transparent text-xs text-[#353a35] outline-none placeholder:text-[#9b9f98]"
                />
              </label>
            </div>

            <div className="max-h-[520px] overflow-y-auto p-3 sm:p-4">
              {loadingList ? (
                <div className="flex items-center justify-center gap-2 py-14 text-xs text-[#828980]">
                  <LoaderCircle className="animate-spin" size={16} />
                  Loading your library
                </div>
              ) : filteredDocuments.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f1f3ef] text-[#7e9282]">
                    {query ? <Search size={18} /> : <FileText size={19} />}
                  </div>
                  <p className="text-sm font-medium text-[#454b45]">
                    {query ? "No matching documents" : "Your library is ready"}
                  </p>
                  <p className="mx-auto mt-1.5 max-w-[230px] text-xs leading-5 text-[#8b9189]">
                    {query
                      ? "Try another file name."
                      : "Upload your first PDF and its extracted text will appear here."}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredDocuments.map((document) => {
                    const isSelected = selected?.id === document.id;
                    return (
                      <li key={document.id}>
                        <button
                          type="button"
                          onClick={() => void openDocument(document)}
                          className={`group w-full rounded-[15px] border p-3.5 text-left transition ${
                            isSelected
                              ? "border-[#b8c9bc] bg-[#f3f7f2]"
                              : "border-transparent bg-[#fafaf8] hover:border-[#e4e8e1] hover:bg-[#f6f7f3]"
                          }`}
                        >
                          <span className="flex items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e9eee8] text-[#55705d]">
                              <FileText size={17} strokeWidth={1.7} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-3">
                                <span className="truncate text-[13px] font-semibold text-[#343a34]">
                                  {document.filename}
                                </span>
                                <ChevronRight
                                  size={15}
                                  className={`shrink-0 text-[#a2aaa1] transition group-hover:translate-x-0.5 ${
                                    isSelected ? "text-[#55705d]" : ""
                                  }`}
                                />
                              </span>
                              <span className="mt-1.5 flex items-center gap-2 text-[10px] text-[#898f87]">
                                <span>{formatDate(document.uploaded_at)}</span>
                                <span className="h-1 w-1 rounded-full bg-[#c6cbc3]" />
                                <span>{document.page_count} pages</span>
                                <span className="h-1 w-1 rounded-full bg-[#c6cbc3]" />
                                <span>{formatBytes(document.file_size)}</span>
                              </span>
                              {document.index_status === "pending" && (
                                <span className="mt-2 inline-flex rounded-full bg-[#fbf4df] px-2 py-1 text-[10px] font-medium text-[#806a37]">
                                  AI search indexing pending
                                </span>
                              )}
                              {document.text_preview && (
                                <span className="mt-2 block line-clamp-2 text-[11px] leading-[1.55] text-[#81877f]">
                                  {document.text_preview}
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section className="min-h-[340px] overflow-hidden rounded-[22px] border border-[#e6e7e1] bg-white">
            {selected ? (
              <>
                <div className="flex items-start justify-between gap-4 border-b border-[#eeefeb] px-5 py-4 sm:px-6">
                  <div className="min-w-0">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#718775]">
                      <Check size={12} />
                      Text extracted
                    </div>
                    <h2 className="truncate text-sm font-semibold tracking-[-0.02em]">
                      {selected.filename}
                    </h2>
                    <p className="mt-1 text-[11px] text-[#8a9089]">
                      {selected.page_count} pages <span className="px-1">·</span>{" "}
                      {selected.character_count.toLocaleString()} characters
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void downloadOriginal()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e8ebe6] px-2.5 py-2 text-[11px] font-medium text-[#606a60] transition hover:bg-[#f6f7f4]"
                  >
                    <ArrowDownToLine size={14} />
                    <span className="hidden sm:inline">Original PDF</span>
                  </button>
                </div>
                <div className="flex gap-1 border-b border-[#eeefeb] px-5 pt-3 sm:px-6">
                  <button
                    type="button"
                    onClick={() => setActiveTab("text")}
                    className={`inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium ${
                      activeTab === "text"
                        ? "border-b-2 border-[#55705d] text-[#355440]"
                        : "text-[#858b83] hover:text-[#4b574d]"
                    }`}
                  >
                    <BookOpen size={14} />
                    Extracted text
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("chat")}
                    className={`inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium ${
                      activeTab === "chat"
                        ? "border-b-2 border-[#55705d] text-[#355440]"
                        : "text-[#858b83] hover:text-[#4b574d]"
                    }`}
                  >
                    <MessageCircle size={14} />
                    Ask this PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("study")}
                    className={`inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium ${
                      activeTab === "study"
                        ? "border-b-2 border-[#55705d] text-[#355440]"
                        : "text-[#858b83] hover:text-[#4b574d]"
                    }`}
                  >
                    <Sparkles size={14} />
                    Study tools
                  </button>
                </div>
                {selected.index_status === "pending" && (
                  <div className="mx-5 mt-4 rounded-xl border border-[#ece6d4] bg-[#fbf8ef] px-4 py-3 text-xs leading-5 text-[#766b4f] sm:mx-6">
                    This PDF is saved and its extracted text is available. AI search indexing
                    is pending because the AI provider could not index it during upload.
                    Questions that need AI search may fail until the provider is available.
                  </div>
                )}
                {activeTab !== "chat" ? (
                  <div
                    className={
                      activeTab === "study"
                        ? "max-h-[620px] overflow-y-auto"
                        : "max-h-[460px] overflow-y-auto px-5 py-5 sm:px-7 sm:py-6"
                    }
                  >
                    {activeTab === "text" && selected.extracted_text.trim() ? (
                      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.85] text-[#4d544d]">
                        {selected.extracted_text}
                      </pre>
                    ) : activeTab === "text" ? (
                      <div className="rounded-xl bg-[#f7f7f4] px-4 py-5 text-sm leading-6 text-[#777e76]">
                        This PDF doesn’t contain selectable text. It may be a scanned document;
                        OCR isn’t enabled yet.
                      </div>
                    ) : (
                      <div className="max-h-[620px] space-y-5 overflow-y-auto p-5 sm:p-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold">Study this document</h3>
                            <p className="mt-1 text-xs text-[#858b83]">
                              Summaries, explanations, and quizzes grounded in this PDF.
                            </p>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-[#737b72]">
                            Language
                            <select
                              value={studyLanguage}
                              onChange={(event) =>
                                setStudyLanguage(event.target.value as StudyLanguage)
                              }
                              className="rounded-lg border border-[#e8ebe6] bg-white px-2.5 py-2 text-xs text-[#434b43] outline-none focus:border-[#9eafa2]"
                            >
                              <option value="en">English</option>
                              <option value="hi">हिन्दी</option>
                            </select>
                          </label>
                        </div>

                        {chatConfigured === false && (
                          <div className="rounded-xl border border-[#ece6d4] bg-[#fbf8ef] px-4 py-3 text-xs leading-5 text-[#766b4f]">
                            Study tools need an AI provider. Set <code>OPENAI_API_KEY</code> in
                            the backend environment and restart the API.
                          </div>
                        )}

                        <section className="rounded-2xl border border-[#eceee9] bg-[#fbfbfa] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h4 className="text-xs font-semibold">Document summary</h4>
                              <p className="mt-1 text-[11px] text-[#898f87]">
                                A concise overview with source pages.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void createSummary()}
                              disabled={studyBusy || !selected.extracted_text.trim()}
                              className="rounded-lg bg-[#294c3d] px-3 py-2 text-[11px] font-semibold text-white hover:bg-[#1f3d30] disabled:opacity-50"
                            >
                              Generate summary
                            </button>
                          </div>
                          {summaryResult && (
                            <div className="mt-4 border-t border-[#e9ece6] pt-3">
                              <p className="whitespace-pre-wrap text-xs leading-6 text-[#4e574e]">
                                {summaryResult.summary}
                              </p>
                              <p className="mt-2 text-[10px] font-medium text-[#718775]">
                                Source pages: {summaryResult.source_pages.join(", ")}
                              </p>
                            </div>
                          )}
                        </section>

                        <section className="rounded-2xl border border-[#eceee9] bg-[#fbfbfa] p-4">
                          <h4 className="text-xs font-semibold">Explain a topic</h4>
                          <form
                            onSubmit={(event) => void explainTopic(event)}
                            className="mt-3 flex gap-2"
                          >
                            <input
                              value={explanationInput}
                              onChange={(event) => setExplanationInput(event.target.value)}
                              maxLength={1000}
                              placeholder="e.g. Explain the revenue trend"
                              aria-label="Topic to explain"
                              className="min-w-0 flex-1 rounded-lg border border-[#e8ebe6] bg-white px-3 py-2 text-xs outline-none placeholder:text-[#9b9f98] focus:border-[#9eafa2]"
                            />
                            <button
                              type="submit"
                              disabled={studyBusy || !explanationInput.trim()}
                              className="rounded-lg border border-[#dfe5dd] px-3 py-2 text-[11px] font-semibold text-[#526654] hover:bg-[#f2f5f0] disabled:opacity-50"
                            >
                              Explain
                            </button>
                          </form>
                          {explanationResult && (
                            <div className="mt-4 border-t border-[#e9ece6] pt-3">
                              <p className="whitespace-pre-wrap text-xs leading-6 text-[#4e574e]">
                                {explanationResult.explanation}
                              </p>
                              <p className="mt-2 text-[10px] font-medium text-[#718775]">
                                Source pages:{" "}
                                {explanationResult.sources
                                  .map((source) => source.page_number)
                                  .join(", ")}
                              </p>
                            </div>
                          )}
                        </section>

                        <section className="rounded-2xl border border-[#eceee9] bg-[#fbfbfa] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h4 className="text-xs font-semibold">Multiple-choice quiz</h4>
                              <p className="mt-1 text-[11px] text-[#898f87]">
                                Generate five questions, submit your choices, and see your score.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void createQuiz()}
                              disabled={studyBusy || !selected.extracted_text.trim()}
                              className="rounded-lg border border-[#dfe5dd] px-3 py-2 text-[11px] font-semibold text-[#526654] hover:bg-[#f2f5f0] disabled:opacity-50"
                            >
                              New quiz
                            </button>
                          </div>
                          {generatedQuiz && (
                            <div className="mt-4 space-y-4 border-t border-[#e9ece6] pt-4">
                              {generatedQuiz.questions.map((question, questionIndex) => (
                                <fieldset key={`${generatedQuiz.quiz_id}-${questionIndex}`}>
                                  <legend className="text-xs font-medium leading-5 text-[#434b43]">
                                    {questionIndex + 1}. {question.question}
                                    <span className="ml-1.5 text-[10px] font-normal text-[#899087]">
                                      · p. {question.page_number}
                                    </span>
                                  </legend>
                                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                                    {question.options.map((option, optionIndex) => (
                                      <label
                                        key={optionIndex}
                                        className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-5 ${
                                          quizAnswers[questionIndex] === optionIndex
                                            ? "border-[#aabdaa] bg-[#f0f5ef]"
                                            : "border-[#eceee9] bg-white"
                                        }`}
                                      >
                                        <input
                                          type="radio"
                                          name={`quiz-${questionIndex}`}
                                          value={optionIndex}
                                          checked={quizAnswers[questionIndex] === optionIndex}
                                          disabled={quizGrade !== null}
                                          onChange={() =>
                                            setQuizAnswers((answers) =>
                                              answers.map((answer, index) =>
                                                index === questionIndex ? optionIndex : answer,
                                              ),
                                            )
                                          }
                                          className="mt-1 accent-[#42644e]"
                                        />
                                        {option}
                                      </label>
                                    ))}
                                  </div>
                                </fieldset>
                              ))}
                              {!quizGrade ? (
                                <button
                                  type="button"
                                  onClick={() => void submitQuiz()}
                                  disabled={
                                    studyBusy || quizAnswers.some((answer) => answer < 0)
                                  }
                                  className="rounded-lg bg-[#294c3d] px-3 py-2 text-[11px] font-semibold text-white hover:bg-[#1f3d30] disabled:opacity-50"
                                >
                                  Submit answers
                                </button>
                              ) : (
                                <div className="rounded-xl border border-[#dfe8df] bg-[#f2f6f1] p-4">
                                  <p className="text-sm font-semibold text-[#355440]">
                                    Score: {quizGrade.correct_count}/{quizGrade.total} ·{" "}
                                    {quizGrade.score}%
                                  </p>
                                  <div className="mt-3 space-y-3">
                                    {quizGrade.results.map((result, index) => (
                                      <div key={index} className="text-[11px] leading-5">
                                        <p
                                          className={
                                            result.is_correct
                                              ? "font-medium text-[#456b4d]"
                                              : "font-medium text-[#9b4937]"
                                          }
                                        >
                                          {result.is_correct ? "Correct" : "Not quite"} ·{" "}
                                          {result.question}
                                        </p>
                                        <p className="mt-0.5 text-[#687268]">
                                          {result.explanation} · page {result.page_number}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </section>

                        <section className="rounded-2xl border border-[#eceee9] p-4">
                          <h4 className="text-xs font-semibold">Quiz history</h4>
                          {quizHistory.length === 0 ? (
                            <p className="mt-2 text-[11px] text-[#898f87]">
                              Completed and generated quizzes will appear here.
                            </p>
                          ) : (
                            <ul className="mt-2 divide-y divide-[#eeefeb]">
                              {quizHistory.map((entry) => (
                                <li
                                  key={entry.quiz_id}
                                  className="flex items-center justify-between gap-3 py-2 text-[11px]"
                                >
                                  <span className="text-[#687268]">
                                    {formatDate(entry.created_at)} ·{" "}
                                    {entry.language === "hi" ? "हिन्दी" : "English"} ·{" "}
                                    {entry.total} questions
                                  </span>
                                  <span className="font-semibold text-[#526654]">
                                    {entry.submitted ? `${entry.score}%` : "Not submitted"}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex h-[460px] flex-col">
                    <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-7">
                      {chatConfigured === false && (
                        <div className="rounded-xl border border-[#ece6d4] bg-[#fbf8ef] px-4 py-3 text-xs leading-5 text-[#766b4f]">
                          Chat is not configured yet. Set <code>OPENAI_API_KEY</code> in the
                          backend environment and restart the API. Uploaded PDFs stay available.
                        </div>
                      )}
                      {selected.index_status === "no_text" && (
                        <div className="rounded-xl bg-[#f7f7f4] px-4 py-3 text-xs leading-5 text-[#777e76]">
                          There is no selectable text to search in this PDF. Scanned-document OCR
                          is not enabled.
                        </div>
                      )}
                      {chatMessages.length === 0 && (
                        <div className="mx-auto max-w-sm py-8 text-center">
                          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[#eef2ec] text-[#66806b]">
                            <Sparkles size={17} />
                          </div>
                          <p className="text-sm font-medium">Ask a question about this PDF</p>
                          <p className="mt-1.5 text-xs leading-5 text-[#888f87]">
                            Answers are based on relevant passages from this document and include
                            page references.
                          </p>
                        </div>
                      )}
                      {chatMessages.map((message, index) => (
                        <div
                          key={`${index}-${message.role}`}
                          className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[92%] rounded-2xl px-4 py-3 ${
                              message.role === "user"
                                ? "bg-[#294c3d] text-white"
                                : "border border-[#eceee9] bg-[#fbfbfa] text-[#424a42]"
                            }`}
                          >
                            <p className="whitespace-pre-wrap text-[13px] leading-6">
                              {message.content}
                            </p>
                            {message.sources && message.sources.length > 0 && (
                              <div className="mt-3 border-t border-[#e8ebe6] pt-2.5">
                                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#718775]">
                                  Sources
                                </p>
                                <div className="space-y-2">
                                  {message.sources.map((source) => (
                                    <div
                                      key={source.source_id}
                                      className="rounded-lg bg-[#f1f3ef] px-3 py-2 text-[11px] text-[#606b60]"
                                    >
                                      <div className="font-semibold">
                                        [{source.source_id}] {source.filename} · page{" "}
                                        {source.page_number}
                                      </div>
                                      <p className="mt-1 leading-5 text-[#7b827a]">
                                        {source.excerpt}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {chatBusy && (
                        <div className="flex items-center gap-2 text-xs text-[#7e887e]">
                          <LoaderCircle className="animate-spin" size={15} />
                          Finding passages and drafting an answer…
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                    <form
                      onSubmit={(event) => void sendChatMessage(event)}
                      className="flex items-end gap-2 border-t border-[#eeefeb] p-4 sm:px-6"
                    >
                      <textarea
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder="Ask something about this document…"
                        aria-label="Ask a question about this PDF"
                        maxLength={2000}
                        rows={2}
                        disabled={chatBusy || selected.index_status === "no_text"}
                        className="min-h-10 flex-1 resize-none rounded-xl border border-[#e8ebe6] bg-[#fbfbfa] px-3 py-2.5 text-xs leading-5 outline-none placeholder:text-[#9b9f98] focus:border-[#9eafa2] disabled:opacity-60"
                      />
                      <button
                        type="submit"
                        disabled={chatBusy || !chatInput.trim() || selected.index_status === "no_text"}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#294c3d] text-white transition hover:bg-[#1f3d30] disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="Send question"
                      >
                        {chatBusy ? (
                          <LoaderCircle className="animate-spin" size={16} />
                        ) : (
                          <Send size={15} />
                        )}
                      </button>
                    </form>
                  </div>
                )}
              </>
            ) : (
              <div className="flex min-h-[340px] flex-col items-center justify-center px-8 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f1f3ef] text-[#7e9282]">
                  <FileText size={20} strokeWidth={1.7} />
                </div>
                <h2 className="text-sm font-semibold">Extracted text lives here</h2>
                <p className="mt-2 max-w-[280px] text-xs leading-5 text-[#8a9089]">
                  Pick a document from your library to read its text, or add a new PDF above.
                </p>
              </div>
            )}
          </section>
        </div>
        <footer className="mt-8 flex items-center justify-center gap-1.5 text-[10px] text-[#9a9f97]">
          <span>PDF text extraction, powered by PyMuPDF</span>
          <span>·</span>
          <span>Uploaded files stay in your local library</span>
        </footer>
          </>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Show when="signed-in" fallback={<SignInPage />}>
      <SignedInApp />
    </Show>
  );
}

function SignedInApp() {
  const { userId } = useAuth();
  if (!userId) return null;
  return <AuthenticatedApp key={userId} />;
}

function SignInPage() {
  return (
    <div className="min-h-screen bg-[#f7f7f4] text-[#20231f]">
      <header className="border-b border-[#e7e8e2] bg-[#fbfbf9]">
        <div className="mx-auto flex h-[74px] max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="/" className="flex items-center gap-3" aria-label="Papertrail home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#294c3d] text-white">
              <Files size={18} strokeWidth={1.9} />
            </span>
            <span className="text-[17px] font-semibold tracking-[-0.04em]">papertrail</span>
            <span className="hidden rounded-full bg-[#eef1eb] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#557060] sm:inline">
              workspace
            </span>
          </a>
          <div className="flex items-center gap-2">
            <SignInButton mode="modal">
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-xs font-semibold text-[#526654] transition hover:bg-[#f0f2ed]"
              >
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button
                type="button"
                className="rounded-lg bg-[#294c3d] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#1f3d30]"
              >
                Sign up
              </button>
            </SignUpButton>
          </div>
        </div>
      </header>
      <main className="mx-auto flex min-h-[calc(100vh-74px)] max-w-[1440px] items-center justify-center px-5 py-12 sm:px-8">
        <section className="max-w-xl text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf0e9] text-[#355440]">
            <Sparkles size={20} />
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.05em] sm:text-4xl">
            Your study space, in one place.
          </h1>
          <p className="mt-4 text-sm leading-6 text-[#757b74]">
            Sign in or create an account to access your document library and study-hours tracker.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <SignInButton mode="modal">
              <button
                type="button"
                className="rounded-xl border border-[#dfe5dd] bg-white px-5 py-3 text-sm font-semibold text-[#526654] transition hover:bg-[#f5f7f3]"
              >
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button
                type="button"
                className="rounded-xl bg-[#294c3d] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#1f3d30]"
              >
                Create your account
              </button>
            </SignUpButton>
          </div>
        </section>
      </main>
    </div>
  );
}
