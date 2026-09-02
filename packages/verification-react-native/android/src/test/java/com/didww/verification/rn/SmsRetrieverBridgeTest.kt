package com.didww.verification.rn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Parcelable
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowApplication

private const val BODY = "<#> Your DIDWW code is 482913 cnXrLKACSkF"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmsRetrieverBridgeTest {

    private val application get() = RuntimeEnvironment.getApplication()

    private val emitted = mutableListOf<String>()
    private var arms = 0

    private fun bridge(
        context: Context = application,
        arm: () -> Unit = { arms++ },
    ) = SmsRetrieverBridge(context, emitted::add, arm)

    private fun registration(): ShadowApplication.Wrapper? =
        shadowOf(application).registeredReceivers
            .singleOrNull { it.intentFilter.hasAction(SmsRetriever.SMS_RETRIEVED_ACTION) }

    private fun deliver(intent: Intent) {
        val receiver = registration()?.broadcastReceiver ?: error("no receiver is registered")
        receiver.onReceive(application, intent)
    }

    private fun retrieved(
        status: Status?,
        message: String?,
        action: String = SmsRetriever.SMS_RETRIEVED_ACTION,
    ) = Intent(action).apply {
        status?.let { putExtra(SmsRetriever.EXTRA_STATUS, it as Parcelable) }
        message?.let { putExtra(SmsRetriever.EXTRA_SMS_MESSAGE, it) }
    }

    @Test
    fun `registers for the retriever broadcast behind the sender permission`() {
        bridge().start()

        val registration = registration() ?: error("no receiver is registered")
        assertEquals(SmsRetriever.SEND_PERMISSION, registration.broadcastPermission)
        assertTrue(
            "a runtime-exported receiver without the sender permission accepts forged extras",
            registration.flags and ContextCompat.RECEIVER_EXPORTED != 0,
        )
        assertEquals(1, arms)
    }

    @Test
    fun `emits the whole message body for a successful retrieval`() {
        bridge().start()

        deliver(retrieved(Status(CommonStatusCodes.SUCCESS), BODY))

        assertEquals(listOf(BODY), emitted)
    }

    @Test
    fun `re-arms and emits nothing when the retriever window elapses`() {
        bridge().start()
        assertEquals(1, arms)

        deliver(retrieved(Status(CommonStatusCodes.TIMEOUT), null))

        assertEquals(2, arms)
        assertEquals(emptyList<String>(), emitted)
    }

    @Test
    fun `ignores a broadcast for another action`() {
        bridge().start()

        deliver(retrieved(Status(CommonStatusCodes.SUCCESS), BODY, action = Intent.ACTION_VIEW))

        assertEquals(emptyList<String>(), emitted)
    }

    @Test
    fun `ignores a broadcast carrying no status`() {
        bridge().start()

        deliver(retrieved(null, BODY))

        assertEquals(emptyList<String>(), emitted)
    }

    @Test
    fun `ignores a successful broadcast carrying no message`() {
        bridge().start()

        deliver(retrieved(Status(CommonStatusCodes.SUCCESS), null))

        assertEquals(emptyList<String>(), emitted)
    }

    @Test
    fun `unregisters on stop and stays quiet when stopped twice`() {
        val bridge = bridge()
        bridge.start()
        assertNotNull(registration())

        bridge.stop()
        bridge.stop()

        assertNull(registration())
    }

    @Test
    fun `does not throw when stopping against a torn-down context`() {
        val bridge = bridge(context = TornDown(application))
        bridge.start()

        // A throw here would abort a React unmount and leave the Retriever armed for the session.
        bridge.stop()
        bridge.stop()
    }

    @Test
    fun `unregisters when arming fails after a successful registration`() {
        val bridge = bridge(arm = { throw IllegalStateException("the platform service is absent") })

        assertThrows(IllegalStateException::class.java) { bridge.start() }

        assertNull(registration())
    }

    private class TornDown(base: Context) : ContextWrapper(base) {
        override fun unregisterReceiver(receiver: BroadcastReceiver) {
            throw IllegalArgumentException("Receiver not registered")
        }
    }
}
