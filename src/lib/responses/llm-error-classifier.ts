// Re-export shim: the classifier moved to the LLM seam (A+ campaign PR 1c).
// Existing imports keep working; a Stage-2 sweep retargets them and deletes this.
export * from '@/lib/llm/error-classifier';
