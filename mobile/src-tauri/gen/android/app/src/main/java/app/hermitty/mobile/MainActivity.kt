package app.hermitty.mobile

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    /** Android 17 (API 37): zgoda na połączenia w sieci lokalnej (komputer z Hermitty, serwery w domu). Bez niej TCP do 192.168.x.x kończy się przekroczeniem czasu, także w WebView. */
    const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    fun needsLocalNetwork() = Build.VERSION.SDK_INT >= 37
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (needsLocalNetwork() && checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(LOCAL_NETWORK), 61)
    }
  }
}
