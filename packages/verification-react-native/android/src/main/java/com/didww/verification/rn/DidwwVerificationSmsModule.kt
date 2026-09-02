package com.didww.verification.rn

import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DidwwVerificationSmsModule : Module() {

  private var bridge: SmsRetrieverBridge? = null

  override fun definition() = ModuleDefinition {
    Name("DidwwVerificationSms")

    Events("onSmsReceived")

    // Nullable on purpose: a build whose signing certificate cannot be read has no hash, and the
    // JavaScript side reads that as auto-capture being unavailable rather than as an error.
    AsyncFunction("getAppHash") {
      appContext.reactContext?.let(AppHash::compute)
    }

    AsyncFunction("startRetriever") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      stopBridge()
      // Named: a trailing lambda would bind to the bridge's last parameter, its arming seam.
      val started = SmsRetrieverBridge(
        context,
        emit = { message ->
          sendEvent("onSmsReceived", Bundle().apply { putString("message", message) })
        },
      )
      bridge = started
      started.start()
    }

    AsyncFunction("stopRetriever") { stopBridge() }

    OnDestroy { stopBridge() }
  }

  @Synchronized
  private fun stopBridge() {
    bridge?.stop()
    bridge = null
  }
}
