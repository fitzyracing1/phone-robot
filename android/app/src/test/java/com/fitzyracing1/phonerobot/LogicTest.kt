package com.fitzyracing1.phonerobot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class LogicTest {
    @Test fun motionStatsAccelMeasuresDeviationFromGravity() {
        val s = MotionStats(MotionStats.GRAVITY)
        repeat(10) { s.add(0f, 0f, 9.80665f) }
        val still = s.drain()!!
        assertEquals(10, still.n)
        assertEquals(9.80665, still.mean, 1e-4)
        assertEquals(0.0, still.rms, 1e-4)
        s.add(0f, 0f, 12.80665f); s.add(0f, 0f, 6.80665f)
        val shake = s.drain()!!
        assertEquals(3.0, shake.rms, 1e-4)
        assertEquals(3.0, shake.peak, 1e-4)
        assertNull("drain resets the window", s.drain())
    }

    @Test fun motionStatsGyroIsRotationSpeed() {
        val g = MotionStats(0.0)
        g.add(3f, 4f, 0f)
        val snap = g.drain()!!
        assertEquals(5.0, snap.mean, 1e-6)
        assertEquals(5.0, snap.peak, 1e-6)
    }

    @Test fun sampleJsonMatchesServerShape() {
        val o = SampleJson.sample(
            1_792_000_000_000, Fix(40.71281234567, -74.0060123456, 8.25f, 12.0, 1.4f, null, 1_791_999_999_000), "WALKING",
            listOf(Transition("WALKING", "ENTER", 1_791_999_990_000)), MotionStats.Snapshot(500, 9.9, 1.23456, 4.1), null, 87, false,
        )
        assertEquals(1_792_000_000_000, o.getLong("t"))
        val loc = o.getJSONObject("loc")
        assertEquals(40.7128123, loc.getDouble("lat"), 1e-9)
        assertFalse(loc.has("bearing"))
        assertEquals("WALKING", o.getString("activity"))
        assertEquals("ENTER", o.getJSONArray("transitions").getJSONObject(0).getString("type"))
        assertEquals(1.235, o.getJSONObject("motion").getJSONObject("accel").getDouble("rms"), 1e-9)
        assertFalse(o.getJSONObject("motion").has("gyro"))
        assertEquals(87, o.getInt("battery"))
    }

    @Test fun sampleWithoutFixOmitsLoc() {
        val o = SampleJson.sample(1_792_000_000_000, null, null, emptyList(), null, null, null, null)
        assertFalse(o.has("loc")); assertFalse(o.has("motion")); assertFalse(o.has("transitions"))
    }

    @Test fun batchSkipsCorruptLines() {
        val b = SampleJson.batch("pixel", listOf("{\"t\":1}", "", "{torn", "{\"t\":2}"))
        assertEquals("pixel", b.getString("device"))
        assertEquals(2, b.getJSONArray("samples").length())
    }

    @Test fun queueSealsBatchesAndSurvivesRestart() {
        val dir = Files.createTempDirectory("q").toFile()
        val q = SampleQueue(dir, batchSize = 3, maxBatches = 2)
        assertFalse(q.add("{\"t\":1}")); assertFalse(q.add("{\"t\":2}"))
        assertEquals(0, q.size())
        val q2 = SampleQueue(dir, batchSize = 3, maxBatches = 2) // restart: counts the pending lines
        assertTrue(q2.add("{\"t\":3}"))
        assertEquals(1, q2.size())
        assertEquals(3, q2.read(q2.batches().first()).size)
        q2.add("{\"t\":4}"); q2.seal()
        q2.add("{\"t\":5}"); q2.seal()
        assertEquals("oldest batch dropped at the cap", 2, q2.size())
        assertEquals("{\"t\":4}", q2.read(q2.batches().first()).first())
        q2.done(q2.batches().first())
        assertEquals(1, q2.size())
        q2.reject(q2.batches().first())
        assertEquals(0, q2.size())
        assertTrue(dir.resolve("rejected").listFiles()!!.isNotEmpty())
        q2.seal() // nothing pending: no empty batch
        assertEquals(0, q2.size())
        dir.deleteRecursively()
    }

    @Test fun urlValidationIsHttpsOnly() {
        assertNull(Settings.validUrl("https://robot.up.railway.app"))
        assertNotNull(Settings.validUrl("http://robot.example"))
        assertNotNull(Settings.validUrl(""))
        assertNotNull(Settings.validUrl("https://"))
        assertNotNull(Settings.validUrl("not a url"))
    }

    @Test fun deviceNamesAreServerSafe() {
        assertEquals("Pixel-8-Pro", Settings.cleanDevice(" Pixel 8 Pro! "))
        assertEquals("phone", Settings.cleanDevice("???"))
        assertEquals(64, Settings.cleanDevice("a".repeat(100)).length)
        assertTrue(JSONObject().put("d", Settings.cleanDevice("x")).has("d"))
    }
}
