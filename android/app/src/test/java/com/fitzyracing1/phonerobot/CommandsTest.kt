package com.fitzyracing1.phonerobot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandsTest {
    @Test fun parsesKnownCommandsAndDropsTheRest() {
        val json = """
            {"commands":[
              {"id":"a1","type":"start","args":{}},
              {"id":"a2","type":"ping"},
              {"id":"a3","type":"notify","args":{"title":"Hi","body":"Phone at 40.1, -73.9","extra":5}},
              {"id":"a4","type":"call","args":{"to":"+15551234567"}},
              {"id":"bad id!","type":"stop"},
              {"id":"a5","type":"notify","args":{"title":"no body"}},
              {"id":"a6","type":"stop","args":{"reason":"owner asked"}}
            ],"pollSeconds":60}
        """.trimIndent()
        val cmds = CommandCodec.parse(json)
        assertEquals(listOf("a1", "a2", "a3", "a6"), cmds.map { it.id })
        assertEquals(mapOf("title" to "Hi", "body" to "Phone at 40.1, -73.9"), cmds[2].args)
        assertEquals("owner asked", cmds[3].args["reason"])
    }

    @Test fun clampsNotificationText() {
        val long = "x".repeat(500)
        val c = CommandCodec.parse("""{"commands":[{"id":"n","type":"notify","args":{"title":"$long","body":"$long"}}]}""").single()
        assertEquals(120, c.args["title"]!!.length)
        assertEquals(240, c.args["body"]!!.length)
    }

    @Test fun toleratesGarbage() {
        assertTrue(CommandCodec.parse("not json").isEmpty())
        assertTrue(CommandCodec.parse("{}").isEmpty())
        assertTrue(CommandCodec.parse("""{"commands":[1,"x",null]}""").isEmpty())
        assertEquals(60, CommandCodec.pollSeconds("nope"))
        assertEquals(15, CommandCodec.pollSeconds("""{"pollSeconds":1}"""))
        assertEquals(120, CommandCodec.pollSeconds("""{"pollSeconds":120}"""))
    }

    @Test fun ackBodyMatchesServer() {
        val body = CommandCodec.ackBody("pixel-8", listOf(Ack("a1", true, JSONObject().put("state", "paused")), Ack("a2", false)))
        assertEquals("pixel-8", body.getString("device"))
        val acks = body.getJSONArray("acks")
        assertEquals(2, acks.length())
        assertEquals("paused", acks.getJSONObject(0).getJSONObject("result").getString("state"))
        assertFalse(acks.getJSONObject(1).getBoolean("ok"))
        assertFalse(acks.getJSONObject(1).has("result"))
    }

    @Test fun seenIdsDedupesAndIsBounded() {
        val s = SeenIds(max = 3)
        assertTrue(s.firstTime("a")); assertFalse(s.firstTime("a"))
        s.firstTime("b"); s.firstTime("c"); s.firstTime("d")
        assertEquals(listOf("b", "c", "d"), s.snapshot())
        assertTrue("oldest forgotten", s.firstTime("a"))
        val r = SeenIds(); r.restore(listOf("x", "y"))
        assertFalse(r.firstTime("y"))
    }
}
