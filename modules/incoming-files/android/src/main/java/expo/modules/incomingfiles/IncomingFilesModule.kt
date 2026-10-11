package expo.modules.incomingfiles

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import android.provider.OpenableColumns
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

/**
 * Files handed to StackRead by other apps: "Open with" (ACTION_VIEW) and the
 * share sheet (ACTION_SEND / ACTION_SEND_MULTIPLE).
 *
 * ## Why a module
 *
 * React Native's `Linking` reports a VIEW intent's data URI and nothing else:
 * a share puts its file in `EXTRA_STREAM`, which `Linking` never sees, and
 * neither path gives the file's display name or size. This reads the intent,
 * queues what it carries, and copies the bytes into the library on a background
 * thread — the JS-thread `copySync` the picker path uses would freeze the UI
 * for the length of a large PDF.
 *
 * ## Delivery
 *
 * One queue, drained by `takePending()`. A cold start's launch intent is read
 * into it on the first drain (the activity may not exist when the module is
 * created); a warm one arrives through `OnNewIntent`, which also emits
 * `onIncoming` so JS knows to drain. JS drains on both, so an event fired
 * before its listener attached loses nothing.
 *
 * ## Delivered once
 *
 * A consumed launch intent is replaced on the activity, so a JS reload does not
 * import the file again. A launch from recents re-delivers the *original*
 * intent after process death; Android marks it
 * `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`, and it is ignored — that file was
 * imported the first time. (JS also opens an existing copy rather than adding a
 * duplicate, so neither guard is load-bearing alone.)
 *
 * ## Only `content://`
 *
 * A `file://` URI names a path, and a hostile app could name one inside this
 * app's own private storage — the database, say — and have it copied into the
 * library, where it could be shared back out. Since Android 7 a sender cannot
 * hand out `file://` URIs anyway (`FileUriExposedException`), so refusing them
 * costs nothing real. `content://` reads go through the sender's provider and
 * only what it granted.
 */
class IncomingFilesModule : Module() {

  private val pending = ArrayList<Map<String, String?>>()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "No React context", null)

  override fun definition() = ModuleDefinition {
    Name("IncomingFiles")

    Events("onIncoming")

    OnNewIntent { intent ->
      val items = extract(intent)
      if (items.isNotEmpty()) {
        synchronized(pending) { pending.addAll(items) }
        sendEvent("onIncoming", mapOf("count" to items.size))
      }
    }

    /** Everything received and not yet taken: `{ uri, mime }`, oldest first. */
    Function("takePending") {
      readLaunchIntent()
      synchronized(pending) {
        val out = ArrayList(pending)
        pending.clear()
        out
      }
    }

    /** The sender's display name, size and type for a received URI; any may be null. */
    AsyncFunction("describe") { uriString: String ->
      val uri = contentUri(uriString)
      val resolver = context.contentResolver
      var name: String? = null
      var size: Long? = null
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
          }
        }
      mapOf("name" to name, "size" to size, "mime" to resolver.getType(uri))
    }

    /**
     * Copies a received URI to a file inside this app's private files
     * directory, returning the bytes written. A partial copy is deleted.
     */
    AsyncFunction("copyTo") { uriString: String, destination: String ->
      val uri = contentUri(uriString)
      val target = privateTarget(destination)
      try {
        val input = context.contentResolver.openInputStream(uri)
          ?: throw CodedException("ERR_UNREADABLE", "The sending app did not provide the file", null)
        input.use { source ->
          FileOutputStream(target).use { sink -> source.copyTo(sink, BUFFER_BYTES) }
        }
      } catch (error: Throwable) {
        target.delete()
        throw error
      }
      target.length()
    }
  }

  /** Reads the launch intent into the queue, once, then replaces it. */
  private fun readLaunchIntent() {
    val activity = appContext.currentActivity ?: return
    val intent = activity.intent ?: return
    if (intent.action == Intent.ACTION_MAIN) return
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) {
      val items = extract(intent)
      synchronized(pending) { pending.addAll(items) }
    }
    activity.intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
  }

  private fun extract(intent: Intent): List<Map<String, String?>> {
    val uris: List<Uri> = when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent) ?: clipUris(intent).firstOrNull())
      Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent).ifEmpty { clipUris(intent) }
      else -> emptyList()
    }
    // One type for the whole intent; a multiple share of mixed files has a
    // wildcard here, and JS asks the provider per file instead.
    val type = intent.type?.takeUnless { it.contains('*') }
    return uris
      .filter { it.scheme == ContentResolver.SCHEME_CONTENT }
      .map { mapOf("uri" to it.toString(), "mime" to type) }
  }

  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri
    }

  private fun streamListExtra(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM)?.mapNotNull { it as? Uri } ?: emptyList()
    }

  /** Some senders put the file only in ClipData, which is also what carries the read grant. */
  private fun clipUris(intent: Intent): List<Uri> {
    val clip = intent.clipData ?: return emptyList()
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
  }

  private fun contentUri(uriString: String): Uri {
    val uri = Uri.parse(uriString)
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
      throw CodedException("ERR_SCHEME", "Only content:// URIs are accepted", null)
    }
    return uri
  }

  /** The destination, refused unless it resolves inside this app's files directory. */
  private fun privateTarget(destination: String): File {
    val path = Uri.parse(destination).path ?: destination
    val target = File(path).canonicalFile
    val root = context.filesDir.canonicalFile
    if (!target.path.startsWith(root.path + File.separator)) {
      throw CodedException("ERR_DESTINATION", "Destination is outside the app's files", null)
    }
    return target
  }

  companion object {
    private const val BUFFER_BYTES = 256 * 1024
  }
}
