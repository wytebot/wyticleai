package __PACKAGE__;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** Shows a reminder scheduled from the page with WyBuild.reminders.schedule(). Added only when the Reminders feature is on. */
public class WyBuildReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String label = ctx.getApplicationInfo().loadLabel(ctx.getPackageManager()).toString();
            if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel("wybuild_default", label, NotificationManager.IMPORTANCE_DEFAULT));
            Intent open = new Intent(ctx, WyBuildActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            String url = intent.getStringExtra("url");
            if (url != null) open.putExtra("wybuild_url", url);
            int id = (int) (System.nanoTime() & 0x7fffffff);
            PendingIntent pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            int icon = ctx.getResources().getIdentifier("ic_notification_icon", "drawable", ctx.getPackageName());
            if (icon == 0) icon = ctx.getApplicationInfo().icon;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, "wybuild_default") : new Notification.Builder(ctx);
            b.setSmallIcon(icon).setContentTitle(intent.getStringExtra("title")).setContentText(intent.getStringExtra("body")).setContentIntent(pi).setAutoCancel(true);
            nm.notify(id, b.build());
        } catch (Exception ignored) {
            // never crash the app from a background alarm
        }
    }
}
