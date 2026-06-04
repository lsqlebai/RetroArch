package com.retroarch.browser.retroactivity;

import com.retroarch.BuildConfig;
import com.retroarch.browser.preferences.util.CloudAuthManager;
import com.retroarch.browser.preferences.util.CloudGameManager;
import com.retroarch.browser.preferences.util.UserPreferences;
import com.retroarch.playcore.PlayCoreManager;

import android.annotation.TargetApi;
import android.app.NativeActivity;
import android.app.AlertDialog;
import android.content.res.Configuration;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Bundle;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.system.Os;
import android.view.accessibility.AccessibilityManager;
import android.view.HapticFeedbackConstants;
import android.view.InputDevice;
import android.view.Surface;
import android.view.WindowManager;
import android.app.UiModeManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.util.Log;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;


import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.Locale;

/**
 * Class which provides common methods for RetroActivity related classes.
 */
public class RetroActivityCommon extends NativeActivity
{
  static {
    System.loadLibrary("retroarch-activity");
  }

  public static final int FRONTEND_POWERSTATE_NONE = 0;
  public static final int FRONTEND_POWERSTATE_NO_SOURCE = 1;
  public static final int FRONTEND_POWERSTATE_CHARGING = 2;
  public static final int FRONTEND_POWERSTATE_CHARGED = 3;
  public static final int FRONTEND_POWERSTATE_ON_POWER_SOURCE = 4;
  public static final int FRONTEND_ORIENTATION_0 = 0;
  public static final int FRONTEND_ORIENTATION_90 = 1;
  public static final int FRONTEND_ORIENTATION_180 = 2;
  public static final int FRONTEND_ORIENTATION_270 = 3;
  public static final int RETRO_RUMBLE_STRONG = 0;
  public static final int RETRO_RUMBLE_WEAK = 1;
  public static final int REQUEST_CODE_OPEN_DOCUMENT_TREE = 0;
  public boolean sustainedPerformanceMode = true;
  public int screenOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    cleanupSymlinks();
    updateSymlinks();

    PlayCoreManager.getInstance().onCreate(this);
    super.onCreate(savedInstanceState);
  }

  @Override
  protected void onDestroy() {
    PlayCoreManager.getInstance().onDestroy();
    super.onDestroy();
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent intent)
  {
    if (intent == null)
      return;

    switch (requestCode)
    {
      case REQUEST_CODE_OPEN_DOCUMENT_TREE:
        {
          Uri uri = intent.getData();
          if (uri == null)
            break;
          if (Build.VERSION.SDK_INT >= 19)
            getContentResolver().takePersistableUriPermission(uri, intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
          safTreeAdded(uri.toString());
        }
        break;

      default:
        break;
    }
  }

  public void requestOpenDocumentTree()
  {
    startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_CODE_OPEN_DOCUMENT_TREE);
  }

  public void doVibrate(int id, int effect, int strength, int oneShot)
  {
    Vibrator vibrator = null;
    int repeat = 0;
    long[] pattern = {0, 16};
    int[] strengths = {0, strength};

    if (Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.JELLY_BEAN) {
      if (id == -1)
        vibrator = (Vibrator)getSystemService(Context.VIBRATOR_SERVICE);
      else
      {
        InputDevice dev = InputDevice.getDevice(id);

        if (dev != null)
          vibrator = dev.getVibrator();
      }
    }

    if (vibrator == null)
      return;

    if (strength == 0) {
      vibrator.cancel();
      return;
    }

    if (oneShot > 0)
      repeat = -1;
    else
      pattern[1] = 1000;

    if (Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      if (id >= 0)
        Log.i("RetroActivity", "Vibrate id " + id + ": strength " + strength);

      vibrator.vibrate(VibrationEffect.createWaveform(pattern, strengths, repeat), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
    }else{
      vibrator.vibrate(pattern, repeat);
    }
  }

  public void doHapticFeedback(int effect)
  {
    getWindow().getDecorView().performHapticFeedback(effect,
        HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING | HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
    Log.i("RetroActivity", "Haptic Feedback effect " + effect);
  }

  // Exiting cleanly from NDK seems to be nearly impossible.
  // Have to use exit(0) to avoid weird things happening, even with runOnUiThread() approaches.
  // Use a separate JNI function to explicitly trigger the readback.
  public void onRetroArchExit()
  {
      finish();
  }

  public String getCloudSyncServerUrl()
  {
    return CloudAuthManager.getServerUrl(this);
  }

  public String getCloudSyncCookieHeader()
  {
    return CloudAuthManager.getCookieHeader(this);
  }

  public String getCloudSyncGameId()
  {
    return CloudAuthManager.getGameId(this);
  }

  public String getCloudSyncGameIdForContent(String contentPath)
  {
    return CloudAuthManager.getGameIdForContent(this, contentPath);
  }

  public String getCloudSyncUsername()
  {
    return CloudAuthManager.getUsername(this);
  }

  public void showCloudSyncAccountDialog()
  {
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        showCloudSyncAccountDialogOnUiThread();
      }
    });
  }

  public void showCloudGamesDialog()
  {
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        Toast.makeText(RetroActivityCommon.this, "Loading cloud games...", Toast.LENGTH_SHORT).show();
      }
    });

    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          final List<CloudGameManager.CloudGame> games =
                CloudGameManager.fetchGames(RetroActivityCommon.this);
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              showCloudGamesDialogOnUiThread(games);
            }
          });
        } catch (final Exception e) {
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    "Cloud games failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
          });
        }
      }
    }).start();
  }

  public void showTextInputDialog(final String title)
  {
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        final EditText input = new EditText(RetroActivityCommon.this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);

        final AlertDialog dialog = new AlertDialog.Builder(RetroActivityCommon.this)
              .setTitle(title == null || title.length() == 0 ? "Text Input" : title)
              .setView(input)
              .setNegativeButton(android.R.string.cancel, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialogInterface, int which) {
                  textInputDialogResult("", false);
                }
              })
              .setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialogInterface, int which) {
                  textInputDialogResult(input.getText().toString(), true);
                }
              })
              .create();

        dialog.setOnCancelListener(new DialogInterface.OnCancelListener() {
          @Override
          public void onCancel(DialogInterface dialogInterface) {
            textInputDialogResult("", false);
          }
        });
        dialog.setOnShowListener(new DialogInterface.OnShowListener() {
          @Override
          public void onShow(DialogInterface dialogInterface) {
            input.requestFocus();
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
          }
        });
        dialog.show();
      }
    });
  }

  private void showCloudGamesDialogOnUiThread(final List<CloudGameManager.CloudGame> games)
  {
    if (games == null || games.isEmpty())
    {
      Toast.makeText(this, "No cloud games found.", Toast.LENGTH_LONG).show();
      return;
    }

    final String[] labels = new String[games.size()];
    for (int i = 0; i < games.size(); i++)
      labels[i] = games.get(i).toString();

    new AlertDialog.Builder(this)
          .setTitle("Cloud Games")
          .setItems(labels, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
              downloadCloudGame(games.get(which));
            }
          })
          .setNegativeButton("Close", null)
          .show();
  }

  private void downloadCloudGame(final CloudGameManager.CloudGame game)
  {
    Toast.makeText(this, "Downloading " + game + "...", Toast.LENGTH_SHORT).show();

    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          final File file = CloudGameManager.downloadGame(RetroActivityCommon.this, game);
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    "Downloaded to " + file.getAbsolutePath()
                    + ". Open it from Load Content.", Toast.LENGTH_LONG).show();
            }
          });
        } catch (final Exception e) {
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
          });
        }
      }
    }).start();
  }

  private void showCloudSyncAccountDialogOnUiThread()
  {
    final LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    int padding = (int)(20 * getResources().getDisplayMetrics().density);
    layout.setPadding(padding, padding / 2, padding, 0);

    final TextView status = new TextView(this);
    status.setText(CloudAuthManager.isLoggedIn(this)
          ? "Logged in as " + CloudAuthManager.getUsername(this)
          : "Not logged in");

    final EditText serverUrl = new EditText(this);
    serverUrl.setSingleLine(true);
    serverUrl.setHint("Server URL");
    serverUrl.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    serverUrl.setText(CloudAuthManager.getServerUrl(this));

    final EditText username = new EditText(this);
    username.setSingleLine(true);
    username.setHint("Username");
    username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
    username.setText(CloudAuthManager.getUsername(this));

    final EditText password = new EditText(this);
    password.setSingleLine(true);
    password.setHint("Password");
    password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

    layout.addView(status);
    layout.addView(serverUrl);
    layout.addView(username);
    layout.addView(password);

    final boolean loggedIn = CloudAuthManager.isLoggedIn(this);
    final AlertDialog dialog = new AlertDialog.Builder(this)
          .setTitle("Cloud Account")
          .setView(layout)
          .setNegativeButton("Close", null)
          .setNeutralButton(loggedIn ? "Logout" : "Register", null)
          .setPositiveButton("Login", null)
          .create();

    dialog.setOnShowListener(new DialogInterface.OnShowListener() {
      @Override
      public void onShow(DialogInterface dialogInterface) {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
          @Override
          public void onClick(View v) {
            runCloudAuthAction(dialog, serverUrl.getText().toString(),
                  username.getText().toString(), password.getText().toString(), false);
          }
        });
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(new View.OnClickListener() {
          @Override
          public void onClick(View v) {
            if (loggedIn)
              runCloudLogoutAction(dialog);
            else
              runCloudAuthAction(dialog, serverUrl.getText().toString(),
                    username.getText().toString(), password.getText().toString(), true);
          }
        });
      }
    });

    dialog.show();
  }

  private void runCloudAuthAction(final AlertDialog dialog, final String serverUrl,
        final String username, final String password, final boolean register)
  {
    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          final CloudAuthManager.AuthResult result = register
                ? CloudAuthManager.register(RetroActivityCommon.this, serverUrl, username, password)
                : CloudAuthManager.login(RetroActivityCommon.this, serverUrl, username, password);

          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    result.success ? "Cloud account ready." : "Cloud account failed: " + result.message,
                    Toast.LENGTH_LONG).show();
              if (result.success)
                dialog.dismiss();
            }
          });
        } catch (final Exception e) {
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    "Cloud account failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
          });
        }
      }
    }).start();
  }

  private void runCloudLogoutAction(final AlertDialog dialog)
  {
    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          CloudAuthManager.logout(RetroActivityCommon.this);
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this, "Logged out.", Toast.LENGTH_SHORT).show();
              dialog.dismiss();
            }
          });
        } catch (final Exception e) {
          runOnUiThread(new Runnable() {
            @Override
            public void run() {
              Toast.makeText(RetroActivityCommon.this,
                    "Logout failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
          });
        }
      }
    }).start();
  }

  public int getVolumeCount()
  {
    int ret = 0;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      StorageManager storageManager = (StorageManager) getApplicationContext().getSystemService(Context.STORAGE_SERVICE);
      List<StorageVolume> storageVolumeList = storageManager.getStorageVolumes();

      for (int i = 0; i < storageVolumeList.size(); i++) {
        ret++;
      }
      Log.i("RetroActivity", "volume count: " + ret);
    }

    return (int)ret;
  }

  public String getVolumePath(String input)
  {
    String ret = "";

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      int index = Integer.valueOf(input);
      int j = 0;

      StorageManager storageManager = (StorageManager) getApplicationContext().getSystemService(Context.STORAGE_SERVICE);
      List<StorageVolume> storageVolumeList = storageManager.getStorageVolumes();

      for (int i = 0; i < storageVolumeList.size(); i++) {
        if (i == j) {
          ret = String.valueOf(storageVolumeList.get(index).getDirectory());
        }
      }
      Log.i("RetroActivity", "volume path: " + ret);
    }

    return ret;
  }

  public String[] getPersistedSafTrees()
  {
    if (Build.VERSION.SDK_INT >= 19)
    {
      List<android.content.UriPermission> uriPermissions = getContentResolver().getPersistedUriPermissions();
      List<String> trees = new ArrayList<>();
      for (android.content.UriPermission uriPermission : uriPermissions)
      {
        Uri uri = uriPermission.getUri();
        if (uri != null)
          trees.add(uri.toString());
      }
      return trees.toArray(new String[0]);
    }
    else
      return new String[0];
  }

// https://stackoverflow.com/questions/4553650/how-to-check-device-natural-default-orientation-on-android-i-e-get-landscape/4555528#4555528
  public int getDeviceDefaultOrientation() {
    WindowManager windowManager = (WindowManager)getSystemService(Context.WINDOW_SERVICE);
    Configuration config = getResources().getConfiguration();
    int rotation = windowManager.getDefaultDisplay().getRotation();

    if (((rotation == Surface.ROTATION_0 || rotation == Surface.ROTATION_180) &&
        config.orientation == Configuration.ORIENTATION_LANDSCAPE)
        || ((rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) &&
        config.orientation == Configuration.ORIENTATION_PORTRAIT))
    {
      return Configuration.ORIENTATION_LANDSCAPE;
    }else{
      return Configuration.ORIENTATION_PORTRAIT;
    }
  }

  public void setScreenOrientation(int orientation)
  {
    int naturalOrientation = getDeviceDefaultOrientation();
    int newOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;

    // We assume no device has a natural orientation that is reversed
    switch (naturalOrientation) {
      case Configuration.ORIENTATION_PORTRAIT:
      {
        if (orientation == FRONTEND_ORIENTATION_0) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }else if (orientation == FRONTEND_ORIENTATION_90) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        }else if (orientation == FRONTEND_ORIENTATION_180) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
        }else if (orientation == FRONTEND_ORIENTATION_270) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
        }
        break;
      }
      case Configuration.ORIENTATION_LANDSCAPE:
      {
        if (orientation == FRONTEND_ORIENTATION_0) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        }else if (orientation == FRONTEND_ORIENTATION_90) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
        }else if (orientation == FRONTEND_ORIENTATION_180) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
        }else if (orientation == FRONTEND_ORIENTATION_270) {
          newOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }
        break;
      }
    }

    screenOrientation = newOrientation;

    Log.i("RetroActivity", "setting new orientation to " + screenOrientation);

    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        setRequestedOrientation(screenOrientation);
      }
    });
  }

  public String getUserLanguageString()
  {
    String lang = Locale.getDefault().getLanguage();
    String country = Locale.getDefault().getCountry();

    if (lang.length() == 0)
      return "en";

    if (country.length() == 0)
      return lang;

    return lang + '_' + country;
  }

  @TargetApi(24)
  public void setSustainedPerformanceMode(boolean on)
  {
    sustainedPerformanceMode = on;

    if (Build.VERSION.SDK_INT >= 24) {
      if (isSustainedPerformanceModeSupported()) {
        final CountDownLatch latch = new CountDownLatch(1);

        runOnUiThread(new Runnable() {
          @Override
          public void run() {
            Log.i("RetroActivity", "setting sustained performance mode to " + sustainedPerformanceMode);

            getWindow().setSustainedPerformanceMode(sustainedPerformanceMode);

            latch.countDown();
          }
        });

        try {
          latch.await();
        }catch(InterruptedException e) {
          e.printStackTrace();
        }
      }
    }
  }

  @TargetApi(24)
  public boolean isSustainedPerformanceModeSupported()
  {
    boolean supported = false;

    if (Build.VERSION.SDK_INT >= 24)
    {
      PowerManager powerManager = (PowerManager)getSystemService(Context.POWER_SERVICE);

      if (powerManager.isSustainedPerformanceModeSupported())
        supported = true;
    }

    Log.i("RetroActivity", "isSustainedPerformanceModeSupported? " + supported);

    return supported;
  }

  public int getBatteryLevel()
  {
    IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
    // This doesn't actually register anything (or need to) because we know this particular intent is sticky and we do not specify a BroadcastReceiver anyway
    Intent batteryStatus = registerReceiver(null, ifilter);
    int level = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, 0);
    int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, 100);

    float percent = ((float)level / (float)scale) * 100.0f;

    Log.i("RetroActivity", "battery: level = " + level + ", scale = " + scale + ", percent = " + percent);

    return (int)percent;
  }

  public int getPowerstate()
  {
    IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
    // This doesn't actually register anything (or need to) because we know this particular intent is sticky and we do not specify a BroadcastReceiver anyway
    Intent batteryStatus = registerReceiver(null, ifilter);
    int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
    boolean hasBattery = batteryStatus.getBooleanExtra(BatteryManager.EXTRA_PRESENT, false);
    boolean isCharging = (status == BatteryManager.BATTERY_STATUS_CHARGING);
    boolean isCharged = (status == BatteryManager.BATTERY_STATUS_FULL);
    int powerstate = FRONTEND_POWERSTATE_NONE;

    if (isCharged)
      powerstate = FRONTEND_POWERSTATE_CHARGED;
    else if (isCharging)
      powerstate = FRONTEND_POWERSTATE_CHARGING;
    else if (!hasBattery)
      powerstate = FRONTEND_POWERSTATE_NO_SOURCE;
    else
      powerstate = FRONTEND_POWERSTATE_ON_POWER_SOURCE;

    Log.i("RetroActivity", "power state = " + powerstate);

    return powerstate;
  }

  public boolean isAndroidTV()
  {
    Configuration config = getResources().getConfiguration();
    UiModeManager uiModeManager = (UiModeManager)getSystemService(UI_MODE_SERVICE);

    if (uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
    {
      Log.i("RetroActivity", "isAndroidTV == true");
      return true;
    }
    else
    {
      Log.i("RetroActivity", "isAndroidTV == false");
      return false;
    }
  }

  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    int oldOrientation = 0;
    boolean hasOldOrientation = false;

    super.onConfigurationChanged(newConfig);

    Log.i("RetroActivity", "onConfigurationChanged: orientation is now " + newConfig.orientation);

    SharedPreferences prefs = UserPreferences.getPreferences(this);
    SharedPreferences.Editor edit = prefs.edit();

    hasOldOrientation = prefs.contains("ORIENTATION");

    if (hasOldOrientation)
      oldOrientation = prefs.getInt("ORIENTATION", 0);

    edit.putInt("ORIENTATION", newConfig.orientation);
    edit.apply();

    Log.i("RetroActivity", "hasOldOrientation? " + hasOldOrientation + " newOrientation: " + newConfig.orientation + " oldOrientation: " + oldOrientation);
  }

  /**
   * Checks if this version of RetroArch is a Play Store build.
   *
   * @return true if this is a Play Store build, false otherwise
   */
  public boolean isPlayStoreBuild() {
    Log.i("RetroActivity", "isPlayStoreBuild: " + BuildConfig.PLAY_STORE_BUILD);

    return BuildConfig.PLAY_STORE_BUILD;
  }

  /**
   * Gets the list of available cores that can be downloaded as Dynamic Feature Modules.
   *
   * @return the list of available cores
   */
  public String[] getAvailableCores() {
    int id = getResources().getIdentifier("module_names_" + Build.CPU_ABI.replace('-', '_'), "array", getPackageName());

    String[] returnVal = getResources().getStringArray(id);
    Log.i("RetroActivity", "getAvailableCores: " + Arrays.toString(returnVal));
    return returnVal;
  }

  /**
   * Gets the list of cores that are currently installed as Dynamic Feature Modules.
   *
   * @return the list of installed cores
   */
  public String[] getInstalledCores() {
    String[] modules = PlayCoreManager.getInstance().getInstalledModules();
    List<String> cores = new ArrayList<>();
    List<String> availableCores = Arrays.asList(getAvailableCores());

    SharedPreferences prefs = UserPreferences.getPreferences(this);

    for(int i = 0; i < modules.length; i++) {
      String coreName = unsanitizeCoreName(modules[i]);
      if(!prefs.getBoolean("core_deleted_" + coreName, false)
              && availableCores.contains(coreName)) {
        cores.add(coreName);
      }
    }

    String[] returnVal = cores.toArray(new String[0]);
    Log.i("RetroActivity", "getInstalledCores: " + Arrays.toString(returnVal));
    return returnVal;
  }

  /**
   * Asks the system to download a core.
   *
   * @param coreName Name of the core to install
   */
  public void downloadCore(final String coreName) {
    Log.i("RetroActivity", "downloadCore: " + coreName);

    SharedPreferences prefs = UserPreferences.getPreferences(this);
    prefs.edit().remove("core_deleted_" + coreName).apply();

    PlayCoreManager.getInstance().downloadCore(coreName);
  }

  /**
   * Asks the system to delete a core.
   *
   * Note that the actual module deletion will not happen immediately (the OS will delete
   * it whenever it feels like it), but the symlink will still be immediately removed.
   *
   * @param coreName Name of the core to delete
   */
  public void deleteCore(String coreName) {
    Log.i("RetroActivity", "deleteCore: " + coreName);

    String newFilename = getCorePath() + coreName + "_libretro_android.so";
    new File(newFilename).delete();

    SharedPreferences prefs = UserPreferences.getPreferences(this);
    prefs.edit().putBoolean("core_deleted_" + coreName, true).apply();

    PlayCoreManager.getInstance().deleteCore(coreName);
  }



  /////////////// JNI methods ///////////////



  /**
   * Called when a core install is initiated.
   *
   * @param coreName Name of the core that the install is initiated for.
   * @param successful true if success, false if failure
   */
  public native void coreInstallInitiated(String coreName, boolean successful);

  /**
   * Called when the status of a core install has changed.
   *
   * @param coreNames Names of all cores that are currently being downloaded.
   * @param status One of INSTALL_STATUS_DOWNLOADING, INSTALL_STATUS_INSTALLING,
   *               INSTALL_STATUS_INSTALLED, or INSTALL_STATUS_FAILED
   * @param bytesDownloaded Number of bytes downloaded.
   * @param totalBytesToDownload Total number of bytes to download.
   */
  public native void coreInstallStatusChanged(String[] coreNames, int status, long bytesDownloaded, long totalBytesToDownload);

  /**
   * Called when the user grants access to a Storage Access Framework tree.
   */
  public native void safTreeAdded(String tree);

  /**
   * Called when a native platform text input dialog is completed.
   */
  public native void textInputDialogResult(String text, boolean accepted);



  /////////////// Private methods ///////////////



  /**
   * Sanitizes a core name so that it can be used when dealing with
   * Dynamic Feature Modules. Needed because Gradle modules cannot use
   * dashes, but we have at least one core name ("mesen-s") that uses them.
   *
   * @param coreName Name of the core to sanitize.
   * @return The sanitized core name.
   */
  public String sanitizeCoreName(String coreName) {
    return "core_" + coreName.replace('-', '_');
  }

  /**
   * Unsanitizes a core name from its module name.
   *
   * @param coreName Name of the core to unsanitize.
   * @return The unsanitized core name.
   */
  public String unsanitizeCoreName(String coreName) {
    if(coreName.equals("core_mesen_s")) {
      return "mesen-s";
    }

    return coreName.substring(5);
  }

  /**
   * Gets the path to the RetroArch cores directory.
   *
   * @return The path to the RetroArch cores directory
   */
  private String getCorePath() {
    String path = getApplicationInfo().dataDir + "/cores/";
    new File(path).mkdirs();

    return path;
  }

  /**
   * Cleans up existing symlinks before new ones are created.
   */
  private void cleanupSymlinks() {
    if(Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;

    File[] files = new File(getCorePath()).listFiles();
    for(int i = 0; i < files.length; i++) {
      try {
        Os.readlink(files[i].getAbsolutePath());
        files[i].delete();
      } catch (Exception e) {
        // File is not a symlink, so don't delete.
      }
    }
  }

  /**
   * Triggers a symlink update in the known places that Dynamic Feature Modules
   * are installed to.
   */
  public void updateSymlinks() {
    if(!isPlayStoreBuild()) return;

    traverseFilesystem(getFilesDir());
    traverseFilesystem(new File(getApplicationInfo().nativeLibraryDir));
  }

  /**
   * Traverse the filesystem, looking for native libraries.
   * Symlinks any libraries it finds to the main RetroArch "cores" folder,
   * updating any existing symlinks with the correct path to the native libraries.
   *
   * This is necessary because Dynamic Feature Modules are first downloaded
   * and installed to a temporary location on disk, before being moved
   * to a more permanent location by the system at a later point.
   *
   * This could probably be done in native code instead, if that's preferred.
   *
   * @param file The parent directory of the tree to traverse.
   * @param cores List of cores to update.
   * @param filenames List of filenames to update.
   */
  private void traverseFilesystem(File file) {
    if(Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;

    File[] list = file.listFiles();
    if(list == null) return;

    List<String> availableCores = Arrays.asList(getAvailableCores());

    // Check each file in a directory to see if it's a native library.
    for(int i = 0; i < list.length; i++) {
      File child = list[i];
      String name = child.getName();

      if(name.startsWith("lib") && name.endsWith(".so") && !name.contains("retroarch-activity")) {
        // Found a native library!
        String core = name.subSequence(3, name.length() - 3).toString();
        String filename = child.getAbsolutePath();

        SharedPreferences prefs = UserPreferences.getPreferences(this);
        if(!prefs.getBoolean("core_deleted_" + core, false)
                && availableCores.contains(core)) {
          // Generate the destination filename and delete any existing symlinks / cores
          String newFilename = getCorePath() + core + "_libretro_android.so";
          new File(newFilename).delete();

          try {
            Os.symlink(filename, newFilename);
          } catch (Exception e) {
            // Symlink failed to be created. Should never happen.
          }
        }
      } else if(file.isDirectory()) {
        // Found another directory, so traverse it
        traverseFilesystem(child);
      }
    }
  }

  public boolean isScreenReaderEnabled() {
    AccessibilityManager accessibilityManager = (AccessibilityManager) getSystemService(ACCESSIBILITY_SERVICE);
    boolean isAccessibilityEnabled = accessibilityManager.isEnabled();
    boolean isExploreByTouchEnabled = accessibilityManager.isTouchExplorationEnabled();
    return isAccessibilityEnabled && isExploreByTouchEnabled;
  }

  public void accessibilitySpeak(String message) {
    getWindow().getDecorView().announceForAccessibility(message);
  }
}
