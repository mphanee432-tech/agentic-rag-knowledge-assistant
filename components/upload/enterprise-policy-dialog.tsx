"use client"

import * as React from "react"
import { useState, useEffect, useRef } from "react"
import {
  UploadCloud,
  FileText,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Building,
  Lock,
  Globe,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"

interface Department {
  id: string
  name: string
}

interface EnterprisePolicyDialogProps {
  organizationId: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onUploadSuccess?: () => void
}

type UploadStep = "idle" | "uploading" | "indexing" | "success" | "failed"

export function EnterprisePolicyDialog({
  organizationId,
  isOpen,
  onOpenChange,
  onUploadSuccess,
}: EnterprisePolicyDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [reservation, setReservation] = useState<{ documentId: string; projectId: string } | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedDepartment, setSelectedDepartment] = useState<string>("")
  const [loadingDepartments, setLoadingDepartments] = useState(false)
  const [departmentError, setDepartmentError] = useState<string | null>(null)
  const [classification, setClassification] = useState<"standard" | "restricted">("standard")
  const [accessScope, setAccessScope] = useState<"department" | "company">("department")
  const [step, setStep] = useState<UploadStep>("idle")
  const [statusMessage, setStatusMessage] = useState<string>("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch departments for current enterprise organization on mount/open
  useEffect(() => {
    let ignore = false
    if (!isOpen) return
    async function loadDepartments() {
      setLoadingDepartments(true)
      setDepartmentError(null)
      try {
        const res = await fetch(`/api/enterprise/departments?organizationId=${organizationId}`)
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load organization departments.")
        }
        if (!ignore) {
          if (Array.isArray(data?.departments) && data.departments.length > 0) {
            setDepartments(data.departments)
            setSelectedDepartment((prev) => {
              const exists = data.departments.some((d: Department) => d.id === prev)
              return exists ? prev : data.departments[0].id
            })
          } else {
            setDepartments([])
            setSelectedDepartment("")
            setDepartmentError("No departments found for this organization.")
          }
        }
      } catch (err) {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : "Failed to load organization departments."
          setDepartmentError(msg)
          setDepartments([])
          setSelectedDepartment("")
          console.error("Failed to load departments:", err)
        }
      } finally {
        if (!ignore) {
          setLoadingDepartments(false)
        }
      }
    }
    loadDepartments()
    return () => {
      ignore = true
    }
  }, [isOpen, organizationId])

  const resetForm = () => {
    setFile(null)
    setReservation(null)
    setClassification("standard")
    setAccessScope("department")
    setStep("idle")
    setStatusMessage("")
    setErrorMessage(null)
    setDepartmentError(null)
  }

  const handleOpenChange = (open: boolean) => {
    if (isBusy) return
    if (!open) {
      resetForm()
    }
    onOpenChange(open)
  }

  // Enforce rule: Restricted documents can only have department access scope
  const handleClassificationChange = (newClassification: "standard" | "restricted") => {
    setClassification(newClassification)
    if (newClassification === "restricted") {
      setAccessScope("department")
    }
  }

  const validateFile = (selectedFile: File): string | null => {
    const ext = selectedFile.name.split(".").pop()?.toLowerCase()
    if (!["pdf", "txt", "html"].includes(ext || "")) {
      return "Supported formats are .pdf, .txt, and .html only."
    }
    if (selectedFile.size > 25 * 1024 * 1024) {
      return "File size exceeds the 25 MB maximum limit."
    }
    if (selectedFile.size === 0) {
      return "File cannot be empty."
    }
    return null
  }

  const handleFileSelect = (selectedFile: File) => {
    const error = validateFile(selectedFile)
    if (error) {
      setErrorMessage(error)
      setFile(null)
      return
    }
    setErrorMessage(null)
    setFile(selectedFile)
    setReservation(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (step === "uploading" || step === "indexing") return
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) {
      setErrorMessage("Please select a document file to upload.")
      return
    }

    const deptId = selectedDepartment || (departments.length > 0 ? departments[0].id : "")
    if (!deptId) {
      setErrorMessage("Please select a department for this policy.")
      return
    }

    setErrorMessage(null)
    try {
      let uploaded = reservation
      if (!uploaded) {
        setStep("uploading")
        setStatusMessage("1/3 Reserving document and uploading to secure storage...")

        const reserveRes = await fetch("/api/documents/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            filename: file.name,
            fileSize: file.size,
            classification,
            accessScope,
            departmentId: deptId,
          }),
        })

        const reserveData = await reserveRes.json()
        if (!reserveRes.ok) throw new Error(reserveData.error || "Upload authorization failed.")

        const { documentId, projectId, storagePath, token } = reserveData
        const { error: uploadError } = await createClient("enterprise").storage
          .from("documents")
          .uploadToSignedUrl(storagePath, token, file, {
            contentType: file.type || "application/octet-stream",
          })

        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)
        uploaded = { documentId, projectId }
        setReservation(uploaded)
      }

      // 3. Trigger ingestion & publication
      setStep("indexing")
      setStatusMessage("2/3 Extracting content, generating 1536d embeddings, and indexing chunks...")

      const ingestRes = await fetch("/api/enterprise/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uploaded),
      })

      const ingestData = await ingestRes.json()
      if (!ingestRes.ok) {
        if (ingestRes.status === 422) setReservation(null)
        throw new Error(ingestData.error || "Document indexing and publication failed.")
      }

      setStep("success")
      setStatusMessage("3/3 Policy indexed and published successfully!")

      if (onUploadSuccess) {
        onUploadSuccess()
      }

      setTimeout(() => {
        resetForm()
        onOpenChange(false)
      }, 2000)
    } catch (err) {
      console.error("Enterprise upload error:", err)
      setStep("failed")
      setErrorMessage(err instanceof Error ? err.message : "Upload processing failed.")
    }
  }

  const isBusy = step === "uploading" || step === "indexing"

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl rounded-2xl">
        <DialogHeader className="gap-1 mb-2">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <UploadCloud className="size-4" />
            </div>
            <DialogTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Upload Enterprise Policy
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Ingest and index an authoritative policy or SOP document into the Employee Knowledge Copilot.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* File Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!isBusy) setIsDragging(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setIsDragging(false)
            }}
            onDrop={handleDrop}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-primary bg-primary/5"
                : file
                ? "border-emerald-500/50 bg-emerald-500/5 dark:bg-emerald-500/10"
                : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-950/50"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.html"
              className="hidden"
              disabled={isBusy}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleFileSelect(e.target.files[0])
                }
              }}
            />

            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileText className="size-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="text-left overflow-hidden">
                  <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-xs">
                    {file.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB • {file.name.split(".").pop()?.toUpperCase()}
                  </p>
                </div>
                {!isBusy && (
                  <button
                    type="button"
                    aria-label="Remove selected file"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFile(null)
                      setReservation(null)
                    }}
                    className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ml-auto"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5 py-1">
                <UploadCloud className="size-6 text-muted-foreground mb-1" />
                <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
                  Click to browse or drop file here
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Supported: PDF, HTML, TXT (up to 25 MB)
                </p>
              </div>
            )}
          </div>

          {/* Department Selection */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="policy-department" className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                <Building className="size-3.5 text-muted-foreground" />
                <span>Department</span>
              </label>
              {loadingDepartments && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="size-2.5 animate-spin" />
                  Loading...
                </span>
              )}
            </div>
            <select
              id="policy-department"
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              disabled={isBusy || Boolean(reservation) || loadingDepartments || departments.length === 0}
              className="w-full text-xs rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
            >
              {departments.length === 0 ? (
                <option value="" disabled>
                  {loadingDepartments ? "Loading departments..." : "No departments available"}
                </option>
              ) : (
                departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))
              )}
            </select>
            {departmentError && (
              <p className="text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1 mt-1">
                <AlertCircle className="size-3 shrink-0" />
                <span>{departmentError}</span>
              </p>
            )}
          </div>

          {/* Classification & Scope Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Classification */}
            <div className="space-y-1.5">
              <label htmlFor="policy-classification" className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                <ShieldAlert className="size-3.5 text-muted-foreground" />
                <span>Classification</span>
              </label>
              <select
                id="policy-classification"
                value={classification}
                onChange={(e) => handleClassificationChange(e.target.value as "standard" | "restricted")}
                disabled={isBusy || Boolean(reservation)}
                className="w-full text-xs rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              >
                <option value="standard">Standard Policy</option>
                <option value="restricted">Restricted Document</option>
              </select>
            </div>

            {/* Access Scope */}
            <div className="space-y-1.5">
              <label htmlFor="policy-access-scope" className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                <Globe className="size-3.5 text-muted-foreground" />
                <span>Access Scope</span>
              </label>
              <select
                id="policy-access-scope"
                value={accessScope}
                onChange={(e) => setAccessScope(e.target.value as "department" | "company")}
                disabled={isBusy || Boolean(reservation) || classification === "restricted"}
                className="w-full text-xs rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
              >
                <option value="department">Department Only</option>
                <option value="company" disabled={classification === "restricted"}>
                  Company-wide {classification === "restricted" ? "(Standard only)" : ""}
                </option>
              </select>
            </div>
          </div>

          {/* Restricted Notice */}
          {classification === "restricted" && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-[11px] leading-relaxed">
              <Lock className="size-3.5 shrink-0 mt-0.5" />
              <span>
                Restricted documents require explicit grants to be queried. Company-wide scope is locked.
              </span>
            </div>
          )}

          {/* Progress / Status display */}
          {isBusy && (
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-2.5">
              <Loader2 className="size-4 text-primary animate-spin shrink-0" />
              <p className="text-xs text-primary font-medium">{statusMessage}</p>
            </div>
          )}

          {step === "success" && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2.5">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                {statusMessage}
              </p>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center gap-2.5">
              <AlertCircle className="size-4 text-rose-600 dark:text-rose-400 shrink-0" />
              <p className="text-xs text-rose-700 dark:text-rose-300 font-medium">{errorMessage}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => handleOpenChange(false)}
              className="text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isBusy || step === "success" || !file || loadingDepartments || !selectedDepartment}
              className="text-xs gap-1.5 cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isBusy && <Loader2 className="size-3.5 animate-spin" />}
              <span>{isBusy ? "Processing Policy..." : reservation ? "Retry Indexing" : "Upload & Index Policy"}</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
