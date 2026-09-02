package com.didww.verification.rn

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The only assertion that runs against a real PackageManager and a real signing certificate.
 * Everything else about the app hash is measured off-device, where the platform classes are
 * substitutes and an omitted hash has no symptom beyond auto-capture never firing.
 */
@RunWith(AndroidJUnit4::class)
class AppHashDeviceTest {

    @Test
    fun computesElevenWellFormedCharactersFromTheInstalledCertificate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        val hash = AppHash.compute(context)

        assertNotNull("no app hash from a real installed build", hash)
        assertEquals(11, hash!!.length)
        assertTrue("the server would reject $hash", AppHash.wellFormed(hash))
    }
}
