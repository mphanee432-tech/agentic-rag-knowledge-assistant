"use client"

import * as React from "react"
import { useState, useRef, useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  UploadCloud,
  AlertTriangle,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Sparkles,
  FileUp,
  Trash2,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase/client"
import { useChatStore } from "@/lib/store/chat-store"
import { loadWorkspace } from "@/lib/load-workspace"
import type { RealtimeChannel } from "@supabase/supabase-js"

interface DocumentUploaderProps {
  projectId: string
  currentDocCount?: number
  onUploadSuccess?: () => void
  className?: string
  largeDropzone?: boolean
  customInstruction?: string
}

type UploadStatus = "idle" | "uploading" | "processing" | "indexed" | "failed"

export function DocumentUploader({
  projectId,
  onUploadSuccess,
  className = "",
  largeDropzone = false,
  customInstruction,
}: DocumentUploaderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [status, setStatus] = useState<UploadStatus>("idle")
  const [statusText, setStatusText] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [uploadedFilename, setUploadedFilename] = useState<string | null>(null)
  const [failedDocumentId, setFailedDocumentId] = useState<string | null>(null)
  const [isDeletingCorrupted, setIsDeletingCorrupted] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeChannelRef = useRef<RealtimeChannel | null>(null)
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

  const { setDocuments } = useChatStore(useShallow(state => ({
    setDocuments: state.setDocuments,
  })))

  // Cleanup realtime subscription and polling timer on unmount
  useEffect(() => {
    return () => {
      if (activeChannelRef.current) {
        const supabase = createClient("personal")
        supabase.removeChannel(activeChannelRef.current)
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
    }
  }, [])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (status === "idle") {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (status !== "idle") return

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      processFile(files[0])
    }
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processFile(files[0])
    }
  }

  const handleDeleteCorrupted = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    if (!failedDocumentId) {
      setStatus("idle")
      setErrorMessage(null)
      return
    }
    setIsDeletingCorrupted(true)
    try {
      const response = await fetch(`/api/documents?documentId=${failedDocumentId}`, {
        method: "DELETE",
      })
      if (!response.ok) throw new Error((await response.json()).error || "Unable to delete document.")
      const docRes = await fetch(`/api/documents?projectId=${projectId}`)
      const docData = await docRes.json()
      if (docData.documents && useChatStore.getState().activeProjectId === projectId) {
        setDocuments(docData.documents)
      }
      setStatus("idle")
      setErrorMessage(null)
      setFailedDocumentId(null)
      setUploadedFilename(null)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unable to delete document.")
    } finally {
      setIsDeletingCorrupted(false)
    }
  }

  const handleRetry = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setStatus("idle")
    setErrorMessage(null)
    setFailedDocumentId(null)
    setUploadedFilename(null)
    fileInputRef.current?.click()
  }

  const processFile = async (file: File) => {
    setErrorMessage(null)
    setUploadedFilename(file.name)
    setFailedDocumentId(null)

    // 1. Enforce Client-Side Constraints
    const ext = file.name.split(".").pop()?.toLowerCase()
    if (!["pdf", "txt", "html"].includes(ext || "")) {
      setStatus("failed")
      setErrorMessage("Only .pdf, .txt, and .html files are supported.")
      return
    }

    if (file.size > 25 * 1024 * 1024) {
      setStatus("failed")
      setErrorMessage("File exceeds the maximum allowable size of 25MB.")
      return
    }

    setStatus("uploading")
    setStatusText("Uploading directly to secure storage...")

    try {
      const supabase = createClient("personal")

      const reservation = await fetch("/api/documents/upload-url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, filename: file.name, fileSize: file.size }),
      })
      const upload = await reservation.json()
      if (!reservation.ok) throw new Error(upload.error || "Unable to start upload.")
      const { documentId, storagePath, token } = upload
      setFailedDocumentId(documentId)
      const { error: uploadError } = await supabase.storage.from("documents")
        .uploadToSignedUrl(storagePath, token, file, { contentType: file.type || "application/octet-stream" })
      if (uploadError) {
        await fetch("/api/documents?documentId=" + documentId, { method: "DELETE" })
        throw uploadError
      }

      // Immediately after upload() succeeds, set local UI status to "processing"
      setStatus("processing")
      setStatusText("Synthesizing GFM & generating 1536d embeddings...")

      // Refresh documents in store
      try {
        const docRes = await fetch(`/api/documents?projectId=${projectId}`)
        const docData = await docRes.json()
        if (docData.documents && useChatStore.getState().activeProjectId === projectId) {
          setDocuments(docData.documents)
        }
      } catch (e) { }

      // Completion handler
      const handleIndexed = async () => {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        if (activeChannelRef.current) {
          supabase.removeChannel(activeChannelRef.current)
          activeChannelRef.current = null
        }

        setStatus("indexed")
        setStatusText("Document fully indexed!")

        // Refresh documents and suggested queries to unlock chat
        await loadWorkspace(projectId)

        if (onUploadSuccess) {
          onUploadSuccess()
        }

        setTimeout(() => {
          setStatus("idle")
          setStatusText(null)
          setUploadedFilename(null)
        }, 3000)
      }

      // Failure handler
      const handleFailed = async (errMsg?: string) => {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        if (activeChannelRef.current) {
          supabase.removeChannel(activeChannelRef.current)
          activeChannelRef.current = null
        }

        setStatus("failed")
        setErrorMessage(errMsg || "Document ingestion failed during extraction or embedding.")
        setFailedDocumentId(documentId)

        try {
          const docRes = await fetch(`/api/documents?projectId=${projectId}`)
          const docData = await docRes.json()
          if (docData.documents && useChatStore.getState().activeProjectId === projectId) setDocuments(docData.documents)
        } catch (e) { }
      }

      // Subscribe to PostgreSQL changes on the documents table filtered by id=eq.${documentId}
      const channel = supabase
        .channel(`doc-status-${documentId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "documents",
            filter: `id=eq.${documentId}`,
          },
          (payload) => {
            const nextDocument = payload.new as { status?: string; last_ingestion_error?: string }
            const nextStatus = nextDocument.status
            if (nextStatus === "indexed") {
              setStatus("indexed")
              supabase.removeChannel(channel)
              handleIndexed()
            } else if (nextStatus === "failed") {
              setStatus("failed")
              supabase.removeChannel(channel)
              handleFailed(nextDocument.last_ingestion_error)
            }
          }
        )
        .subscribe()

      activeChannelRef.current = channel

      // Recovery includes multiple leases and backoff; a UI timeout is not an ingestion failure.
      let pollCount = 0
      pollTimerRef.current = setInterval(async () => {
        pollCount++
        if (pollCount > 900) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }
          setStatusText("Indexing continues in the background. Reload to check its progress.")
          return
        }

        try {
          const res = await fetch(`/api/documents?projectId=${projectId}`)
          if (res.ok) {
            const data = await res.json()
            const updatedDoc = (data.documents || []).find((d: { id: string; status: string; last_ingestion_error?: string }) => d.id === documentId)
            if (updatedDoc) {
              if (updatedDoc.status === "indexed") {
                await handleIndexed()
              } else if (updatedDoc.status === "failed") {
                await handleFailed(updatedDoc.last_ingestion_error)
              }
            }
          }
        } catch (pollErr) {
          // ignore transient poll errors
        }
      }, 2000)
    } catch (err) {
      console.error("Upload failure:", err)
      setStatus("failed")
      setErrorMessage(err instanceof Error ? err.message : "Upload processing failed.")
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.html"
        onChange={handleFileInputChange}
        className="hidden"
        disabled={status === "uploading" || status === "processing"}
      />

      {/* Soft Free-Tier Processing Warning Banner */}
      <div
        className={`bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 p-3 rounded-lg text-xs flex items-center gap-2 ${largeDropzone ? "w-full max-w-xl mx-auto" : "w-full"
          }`}
      >
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>
          Recommended: Upload files under 25 pages (or ≤ 10MB) for optimal processing on the free tier. Larger files may experience extraction delays.
        </span>
      </div>

      {largeDropzone ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => {
            if (status === "idle") {
              fileInputRef.current?.click()
            }
          }}
          className={`relative border-2 border-dashed rounded-2xl p-8 md:p-12 flex flex-col items-center justify-center text-center transition-all cursor-pointer w-full max-w-xl mx-auto shadow-sm ${isDragging
              ? "border-primary bg-primary/10 scale-[1.01]"
              : status === "failed"
                ? "border-rose-400 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20"
                : "border-zinc-300 dark:border-zinc-700 hover:border-primary/60 hover:bg-zinc-50/80 dark:hover:bg-zinc-900/60 bg-white/60 dark:bg-zinc-900/40"
            }`}
        >
          {status === "failed" ? (
            <div className="flex flex-col items-center gap-3 py-4 text-rose-600 dark:text-rose-400">
              <div className="size-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 flex items-center justify-center mb-1 shadow-xs">
                <AlertTriangle className="size-8" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-center gap-2">
                  <Badge variant="destructive" className="gap-1 px-2.5 py-1 text-xs font-semibold">
                    Failed - Retry
                  </Badge>
                  {uploadedFilename && (
                    <span className="text-xs font-mono text-zinc-500 truncate max-w-[200px]">
                      {uploadedFilename}
                    </span>
                  )}
                </div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 tracking-tight mt-1">
                  Document Processing Failed
                </h3>
                <p className="text-xs text-rose-500 dark:text-rose-400/90 max-w-md mx-auto">
                  {errorMessage || "Document extraction or embedding generation failed during ingestion. Delete the corrupted document or retry uploading."}
                </p>
              </div>

              <div className="flex items-center gap-2 mt-2">
                {failedDocumentId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeleteCorrupted}
                    disabled={isDeletingCorrupted}
                    className="gap-1.5 border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 cursor-pointer shadow-xs"
                  >
                    {isDeletingCorrupted ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    <span>Delete Corrupted Document</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleRetry}
                  className="gap-1.5 cursor-pointer shadow-xs"
                >
                  <RotateCcw className="size-4" />
                  <span>Retry Upload</span>
                </Button>
              </div>
            </div>
          ) : status === "uploading" ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="size-10 text-primary animate-spin" />
              <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                <span>Uploading</span>
                <span className="font-mono text-muted-foreground truncate max-w-[200px]">
                  {uploadedFilename}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{statusText}</p>
            </div>
          ) : status === "processing" ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="relative">
                <Loader2 className="size-10 text-amber-500 animate-spin" />
                <Sparkles className="size-4 text-amber-500 absolute -top-1 -right-1 animate-pulse" />
              </div>
              <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                Processing Multimodal Chunks & Queries
              </div>
              <p className="text-xs text-muted-foreground max-w-[280px]">
                {statusText}
              </p>
            </div>
          ) : status === "indexed" ? (
            <div className="flex flex-col items-center gap-3 py-4 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-10" />
              <div className="text-sm font-semibold">Document Fully Indexed!</div>
              <p className="text-xs text-muted-foreground">{statusText}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="size-16 rounded-2xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center mb-1 shadow-xs">
                <UploadCloud className="size-8" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 tracking-tight">
                  {customInstruction || "Upload a document in the sidebar to unlock the workspace."}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-md mx-auto">
                  Drag and drop your engineering RFCs, system specs, error logs, or API contracts here (or upload from the sidebar) to unlock verified RAG retrieval.
                </p>
              </div>

              <div className="flex items-center gap-2 mt-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="gap-2 cursor-pointer shadow-xs"
                >
                  <FileUp className="size-4" />
                  <span>Select Technical Document</span>
                </Button>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2 mt-2 text-[11px] text-zinc-400">
                <Badge variant="outline" className="text-[10px] font-mono">
                  .pdf
                </Badge>
                <Badge variant="outline" className="text-[10px] font-mono">
                  .txt
                </Badge>
                <Badge variant="outline" className="text-[10px] font-mono">
                  .html
                </Badge>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span>Max 25MB</span>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span>1536d Hybrid Retrieval</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => {
            if (status === "idle") {
              fileInputRef.current?.click()
            }
          }}
          className={`relative border-2 border-dashed rounded-xl p-4 flex flex-col items-center justify-center text-center transition-all cursor-pointer ${isDragging
              ? "border-primary bg-primary/5 scale-[0.99]"
              : status === "failed"
                ? "border-rose-400 dark:border-rose-800 bg-rose-50/40 dark:bg-rose-950/20"
                : "border-zinc-200 dark:border-zinc-800 hover:border-primary/50 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 bg-white/40 dark:bg-zinc-950/40"
            }`}
        >
          {status === "failed" ? (
            <div className="flex flex-col items-center gap-2 py-2 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="size-6 text-rose-500" />
              <div className="flex items-center gap-1.5">
                <Badge variant="destructive" className="text-[10px] px-2 py-0.5 font-semibold">
                  Failed - Retry
                </Badge>
                {uploadedFilename && (
                  <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[120px]">
                    {uploadedFilename}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-rose-500/90 max-w-[200px] text-center">
                {errorMessage || "Document ingestion failed."}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                {failedDocumentId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={handleDeleteCorrupted}
                    disabled={isDeletingCorrupted}
                    className="text-[10px] h-6 px-2 gap-1 border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 cursor-pointer"
                  >
                    {isDeletingCorrupted ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                    <span>Delete</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  onClick={handleRetry}
                  className="text-[10px] h-6 px-2 gap-1 cursor-pointer"
                >
                  <RotateCcw className="size-3" />
                  <span>Retry</span>
                </Button>
              </div>
            </div>
          ) : status === "uploading" ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <Loader2 className="size-6 text-primary animate-spin" />
              <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <span>Uploading</span>
                <span className="font-mono text-muted-foreground truncate max-w-[140px]">
                  {uploadedFilename}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">{statusText}</p>
            </div>
          ) : status === "processing" ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="relative">
                <Loader2 className="size-6 text-amber-500 animate-spin" />
                <Sparkles className="size-3 text-amber-500 absolute -top-1 -right-1 animate-pulse" />
              </div>
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Processing Multimodal Chunks
              </div>
              <p className="text-[10px] text-muted-foreground max-w-[220px]">
                {statusText}
              </p>
            </div>
          ) : status === "indexed" ? (
            <div className="flex flex-col items-center gap-2 py-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-6" />
              <div className="text-xs font-medium">Document Fully Indexed!</div>
              <p className="text-[10px] text-muted-foreground">{statusText}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 py-1">
              <div className="size-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-1">
                <UploadCloud className="size-4.5" />
              </div>
              <span className="text-xs font-semibold text-foreground">
                Direct-to-Storage Ingest
              </span>
              <span className="text-[10px] text-muted-foreground max-w-[200px]">
                Drag & drop or browse .pdf, .txt, .html (max 25MB)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error alert */}
      {errorMessage && status !== "failed" && (
        <div className="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-[11px] flex items-start gap-1.5">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <span className="flex-1">{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-500 hover:text-rose-700 text-xs font-bold px-1"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
