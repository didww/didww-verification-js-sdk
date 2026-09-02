package com.didww.verification.rn

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The JavaScript side resolves this module by string name and calls these functions by string
 * name. A disagreement fails no build: the lookup answers `null`, the SDK degrades to manual
 * entry, and auto-capture is silently dead on every device.
 */
class ModuleDefinitionTest {

    private val definition = DidwwVerificationSmsModule().definition()

    @Test
    fun `registers under the name the JavaScript side looks up`() {
        assertEquals("DidwwVerificationSms", definition.name)
    }

    @Test
    fun `exposes the three functions the JavaScript side calls`() {
        assertEquals(
            setOf(
                "getAppHash",
                "startRetriever",
                "stopRetriever",
                // Added by expo-modules-core itself, not declared here.
                "startObserving",
                "stopObserving",
            ),
            // A set, not a list: the definition's iteration order is not stable.
            definition.asyncFunctions.keys.toSet(),
        )
        assertEquals(emptySet<String>(), definition.syncFunctions.keys.toSet())
    }

    @Test
    fun `declares the one event the JavaScript listener subscribes to`() {
        assertEquals(listOf("onSmsReceived"), definition.eventsDefinition?.names?.toList())
    }
}
