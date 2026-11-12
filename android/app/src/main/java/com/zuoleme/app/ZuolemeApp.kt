package com.zuoleme.app

import android.app.Application
import com.zuoleme.app.notify.Notifier

class ZuolemeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
    }
}
