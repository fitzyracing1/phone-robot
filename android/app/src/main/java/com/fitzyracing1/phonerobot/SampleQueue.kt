package com.fitzyracing1.phonerobot

import java.io.File

/**
 * Offline-safe queue on disk. Samples are appended to pending.ndjson; every [batchSize] samples the file is sealed
 * as batch-<time>.ndjson. The uploader sends sealed batches oldest first and deletes each one only after the server
 * accepts it. At most [maxBatches] are kept (oldest dropped first), so a long time offline can't fill the disk.
 */
class SampleQueue(private val dir: File, private val batchSize: Int = 6, private val maxBatches: Int = 4320) {
    private val pending = File(dir, "pending.ndjson")
    private val rejected = File(dir, "rejected")
    private var pendingCount = -1

    init { dir.mkdirs() }

    @Synchronized
    fun add(line: String): Boolean {
        require(!line.contains('\n')) { "one sample per line" }
        if (pendingCount < 0) pendingCount = if (pending.exists()) pending.readLines().count { it.isNotBlank() } else 0
        pending.appendText(line + "\n")
        pendingCount++
        if (pendingCount >= batchSize) { seal(); return true }
        return false
    }

    /** Move whatever is pending into a batch (also used when logging stops). */
    @Synchronized
    fun seal() {
        if (!pending.exists() || pending.length() == 0L) { pendingCount = 0; return }
        var target = File(dir, "batch-${System.currentTimeMillis()}.ndjson")
        var i = 0
        while (target.exists()) target = File(dir, "batch-${System.currentTimeMillis()}-${++i}.ndjson")
        pending.renameTo(target)
        pendingCount = 0
        trim()
    }

    @Synchronized
    fun batches(): List<File> =
        (dir.listFiles { f -> f.isFile && f.name.startsWith("batch-") && f.name.endsWith(".ndjson") } ?: emptyArray())
            .sortedWith(compareBy({ order(it)[0] }, { order(it)[1] }))

    /** batch-<ms>.ndjson or batch-<ms>-<n>.ndjson (same millisecond) → [ms, n]. */
    private fun order(f: File): LongArray {
        val parts = f.name.removePrefix("batch-").substringBefore('.').split('-')
        return longArrayOf(parts[0].toLongOrNull() ?: 0L, parts.getOrNull(1)?.toLongOrNull() ?: 0L)
    }

    fun size(): Int = batches().size

    fun read(f: File): List<String> = f.readLines().filter { it.isNotBlank() }

    @Synchronized
    fun done(f: File) { f.delete() }

    /** The server said this batch is malformed (HTTP 400): keep it aside for debugging instead of retrying forever. */
    @Synchronized
    fun reject(f: File) {
        rejected.mkdirs()
        f.renameTo(File(rejected, f.name))
        (rejected.listFiles()?.sortedBy { it.name } ?: emptyList()).dropLast(50).forEach { it.delete() }
    }

    private fun trim() {
        val all = batches()
        if (all.size > maxBatches) all.take(all.size - maxBatches).forEach { it.delete() }
    }
}
