package com.zuoleme.app

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.zuoleme.app.data.TodoEntity
import com.zuoleme.app.data.TodoRepository
import com.zuoleme.app.device.DeviceCare
import com.zuoleme.app.domain.RemainingText
import com.zuoleme.app.service.PinnedTodoService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private val BgColor = Color(0xFF0B1020)
private val CardColor = Color(0xFF151B30)
private val BrandGreen = Color(0xFF34D399)
private val DangerRed = Color(0xFFF87171)
private val GrayText = Color(0xFF9AA3B8)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PinnedTodoService.start(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(background = BgColor, surface = CardColor)) {
                Surface(modifier = Modifier.fillMaxSize(), color = BgColor) {
                    ZuolemeScreen()
                }
            }
        }
    }

    companion object {
        const val EXTRA_TODO_ID = "todo_id"
    }
}

/** 待确认操作：完成（绿色确认）/ 删除（红色确认），均走中文弹窗，不用系统英文按钮 */
private sealed interface PendingConfirm {
    data class Complete(val todo: TodoEntity) : PendingConfirm
    data class Delete(val todo: TodoEntity) : PendingConfirm
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ZuolemeScreen() {
    val context = LocalContext.current
    val repository = remember { TodoRepository.get(context) }
    val scope = rememberCoroutineScope()
    val todos by repository.observeTodos().collectAsState(initial = emptyList())
    val pinned by repository.observeNearestPending().collectAsState(initial = null)

    var pendingConfirm by remember { mutableStateOf<PendingConfirm?>(null) }
    var editorTodo by remember { mutableStateOf<TodoEntity?>(null) }
    var editorOpen by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

    // 倒计时每秒刷新（界面内）；常驻通知侧由前台服务每分钟刷新
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000L)
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { PinnedTodoService.start(context) }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text("做了么", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = Color.White)
                Text("六档提醒，不漏事。原生版：提醒在手机本地调度，不依赖服务器。", color = GrayText, style = MaterialTheme.typography.bodySmall)
            }

            item { PinnedCard(todo = pinned, now = now, onDone = { pendingConfirm = PendingConfirm.Complete(it) }) }

            item {
                Text("全部待办", color = Color.White, fontWeight = FontWeight.SemiBold)
            }
            if (todos.isEmpty()) {
                item { Text("还没有待办，点右下角按钮新建一条。", color = GrayText) }
            }
            items(todos, key = { it.id }) { todo ->
                TodoRow(
                    todo = todo,
                    now = now,
                    onToggleDone = {
                        if (todo.done) {
                            scope.launch { repository.setDone(todo.id, false) }
                        } else {
                            pendingConfirm = PendingConfirm.Complete(todo)
                        }
                    },
                    onEdit = {
                        editorTodo = todo
                        editorOpen = true
                    },
                    onDelete = { pendingConfirm = PendingConfirm.Delete(todo) },
                )
            }

            item { PermissionSettingsCard(now = now) }

            item {
                Text(
                    "提醒在手机本地调度：关网、关服务器都不影响；重启手机后会自动恢复。" +
                        "请把本应用的电池用量设为「不受限」，避免国产系统把前台服务冻掉。",
                    color = GrayText,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(72.dp))
            }
        }

        FloatingActionButton(
            onClick = {
                editorTodo = null
                editorOpen = true
            },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            containerColor = BrandGreen,
        ) {
            Icon(Icons.Filled.Add, contentDescription = "新建待办")
        }
    }

    if (editorOpen) {
        TodoEditorDialog(
            initial = editorTodo,
            onDismiss = { editorOpen = false },
            onSave = { title, deadline ->
                scope.launch {
                    if (editorTodo == null) {
                        repository.create(title, deadline)
                    } else {
                        repository.updateFields(editorTodo!!.id, title, deadline)
                    }
                    PinnedTodoService.start(context)
                    editorOpen = false
                }
            },
        )
    }

    pendingConfirm?.let { pending ->
        val (title, message, confirmText, confirmColor) = when (pending) {
            is PendingConfirm.Complete -> ConfirmTexts("完成「${pending.todo.title}」？", "完成后将不再提醒这件事。", "确认完成", BrandGreen)
            is PendingConfirm.Delete -> ConfirmTexts("删除「${pending.todo.title}」？", "该事项的所有提醒会一起删除，删了就找不回来。", "确认删除", DangerRed)
        }
        ChineseConfirmDialog(
            title = title,
            message = message,
            confirmText = confirmText,
            confirmColor = confirmColor,
            onCancel = { pendingConfirm = null },
            onConfirm = {
                scope.launch {
                    when (pending) {
                        is PendingConfirm.Complete -> repository.setDone(pending.todo.id, true)
                        is PendingConfirm.Delete -> repository.delete(pending.todo.id)
                    }
                    PinnedTodoService.start(context)
                    pendingConfirm = null
                }
            },
        )
    }
}

private data class ConfirmTexts(val title: String, val message: String, val confirmText: String, val confirmColor: Color)

/**
 * 中文确认弹窗：取消是灰色描边框按钮，确认是绿色/红色实心带同色边框按钮，
 * 弹窗本身带边框——不再出现系统原生弹窗的英文 CANCEL / OK。
 */
@Composable
private fun ChineseConfirmDialog(
    title: String,
    message: String,
    confirmText: String,
    confirmColor: Color,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        modifier = Modifier.border(2.dp, Color.White.copy(alpha = 0.35f), RoundedCornerShape(20.dp)),
        containerColor = CardColor,
        title = { Text(title, color = Color.White) },
        text = { Text(message, color = GrayText) },
        dismissButton = {
            TextButton(
                onClick = onCancel,
                modifier = Modifier.border(2.dp, Color.White.copy(alpha = 0.4f), RoundedCornerShape(10.dp)),
                colors = ButtonDefaults.textButtonColors(contentColor = GrayText),
            ) { Text("取消") }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier
                    .border(2.dp, confirmColor, RoundedCornerShape(10.dp))
                    .background(confirmColor.copy(alpha = 0.18f), RoundedCornerShape(10.dp)),
                colors = ButtonDefaults.textButtonColors(contentColor = confirmColor),
            ) { Text(confirmText, fontWeight = FontWeight.Bold) }
        },
    )
}

@Composable
private fun PinnedCard(todo: TodoEntity?, now: Long, onDone: (TodoEntity) -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = CardColor), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("常驻 · 最近一件事", color = GrayText, style = MaterialTheme.typography.labelMedium)
            if (todo == null) {
                Text("现在没有待办。", color = Color.White, modifier = Modifier.padding(top = 8.dp))
            } else {
                Text(todo.title, color = Color.White, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
                Text(
                    RemainingText.format(todo.deadline - now),
                    color = if (todo.deadline - now <= 0) DangerRed else BrandGreen,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Text("截止 ${formatDeadline(todo.deadline)}", color = GrayText, style = MaterialTheme.typography.bodySmall)
                Button(
                    onClick = { onDone(todo) },
                    modifier = Modifier.padding(top = 12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = BrandGreen, contentColor = Color.Black),
                ) { Text("完成") }
            }
        }
    }
}

@Composable
private fun TodoRow(
    todo: TodoEntity,
    now: Long,
    onToggleDone: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = CardColor), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable { onEdit() }.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = todo.done, onCheckedChange = { onToggleDone() })
            Column(Modifier.weight(1f)) {
                Text(
                    todo.title,
                    color = if (todo.done) GrayText else Color.White,
                    textDecoration = if (todo.done) TextDecoration.LineThrough else null,
                )
                Text(
                    "${formatDeadline(todo.deadline)} · ${if (todo.done) "已完成" else RemainingText.format(todo.deadline - now)}",
                    color = GrayText,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, contentDescription = "删除", tint = GrayText)
            }
        }
    }
}

@Composable
private fun PermissionSettingsCard(now: Long) {
    val context = LocalContext.current
    val alarmManager = remember { context.getSystemService(AlarmManager::class.java) }
    val powerManager = remember { context.getSystemService(PowerManager::class.java) }
    // now 仅用于让状态随界面刷新重新读取
    @Suppress("UNUSED_EXPRESSION")
    now
    val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager?.canScheduleExactAlarms() == true
    val ignoringBattery = powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true

    Card(colors = CardDefaults.cardColors(containerColor = CardColor), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("系统权限（保活必看）", color = Color.White, fontWeight = FontWeight.SemiBold)
            Text("精确闹钟：${if (canExact) "已开启" else "未开启，提醒可能延后"}", color = GrayText, style = MaterialTheme.typography.bodySmall)
            if (!canExact && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                TextButton(onClick = {
                    val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))
                    context.startActivity(intent)
                }) { Text("去开启精确闹钟", color = BrandGreen) }
            }
            Text("电池优化豁免：${if (ignoringBattery) "已豁免" else "未豁免，系统可能冻掉常驻服务"}", color = GrayText, style = MaterialTheme.typography.bodySmall)
            if (!ignoringBattery) {
                TextButton(onClick = {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                    context.startActivity(intent)
                }) { Text("去豁免电池优化", color = BrandGreen) }
            }

            if (DeviceCare.isCurrentDeviceColorOsLike()) {
                Text(
                    "真我 / ColorOS 保活（当前设备：${DeviceCare.deviceLabel()}）",
                    color = Color.White,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Text(
                    "realme UI 默认冻结后台，这三步缺一就可能通知消失，且应用读不到这些开关的状态、只能指路：\n" +
                        "1. 自启动：点下面按钮，在列表里打开「做了么」；\n" +
                        "2. 耗电量：应用详情 → 耗电量 → 选「允许完全后台行为」（新版本叫不受限制），顺手关掉「未使用时暂停应用活动」；\n" +
                        "3. 锁定后台：最近任务里长按「做了么」卡片选「锁定」，并确认不在「应用快速冻结」名单里，平时别开省电模式。",
                    color = GrayText,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = { DeviceCare.openAutoStartSettings(context) }) {
                    Text("去开自启动（真我/ColorOS）", color = BrandGreen)
                }
                TextButton(onClick = { DeviceCare.openAppDetails(context) }) {
                    Text("去应用详情改耗电量", color = BrandGreen)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TodoEditorDialog(
    initial: TodoEntity?,
    onDismiss: () -> Unit,
    onSave: (title: String, deadline: Long) -> Unit,
) {
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var deadline by remember {
        mutableLongStateOf(initial?.deadline ?: (System.currentTimeMillis() + 3_600_000L))
    }
    var error by remember { mutableStateOf<String?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.border(2.dp, Color.White.copy(alpha = 0.25f), RoundedCornerShape(20.dp)),
        containerColor = CardColor,
        title = { Text(if (initial == null) "新建待办" else "编辑", color = Color.White) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("要做什么") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("截止：${formatDeadline(deadline)}", color = GrayText)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { showDatePicker = true }) { Text("选日期", color = BrandGreen) }
                    TextButton(onClick = { showTimePicker = true }) { Text("选时间", color = BrandGreen) }
                }
                error?.let { Text(it, color = DangerRed, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.border(2.dp, Color.White.copy(alpha = 0.4f), RoundedCornerShape(10.dp)),
                colors = ButtonDefaults.textButtonColors(contentColor = GrayText),
            ) { Text("取消") }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    when {
                        title.isBlank() -> error = "请填写待办内容"
                        deadline <= System.currentTimeMillis() -> error = "截止时间必须晚于现在"
                        else -> onSave(title.trim(), deadline)
                    }
                },
                modifier = Modifier
                    .border(2.dp, BrandGreen, RoundedCornerShape(10.dp))
                    .background(BrandGreen.copy(alpha = 0.18f), RoundedCornerShape(10.dp)),
                colors = ButtonDefaults.textButtonColors(contentColor = BrandGreen),
            ) { Text("保存", fontWeight = FontWeight.Bold) }
        },
    )

    if (showDatePicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = deadline + TimeZone.getDefault().getOffset(deadline))
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { pickedUtc ->
                        val picked = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = pickedUtc }
                        val cal = Calendar.getInstance().apply {
                            timeInMillis = deadline
                            set(Calendar.YEAR, picked.get(Calendar.YEAR))
                            set(Calendar.MONTH, picked.get(Calendar.MONTH))
                            set(Calendar.DAY_OF_MONTH, picked.get(Calendar.DAY_OF_MONTH))
                        }
                        deadline = cal.timeInMillis
                    }
                    showDatePicker = false
                }) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("取消") } },
        ) { DatePicker(state = state) }
    }

    if (showTimePicker) {
        val cal = remember { Calendar.getInstance() }
        val state = rememberTimePickerState(
            initialHour = cal.apply { timeInMillis = deadline }.get(Calendar.HOUR_OF_DAY),
            initialMinute = cal.get(Calendar.MINUTE),
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { showTimePicker = false },
            containerColor = CardColor,
            title = { Text("选择时间", color = Color.White) },
            text = { TimePicker(state = state) },
            dismissButton = { TextButton(onClick = { showTimePicker = false }) { Text("取消", color = GrayText) } },
            confirmButton = {
                TextButton(onClick = {
                    val newCal = Calendar.getInstance().apply {
                        timeInMillis = deadline
                        set(Calendar.HOUR_OF_DAY, state.hour)
                        set(Calendar.MINUTE, state.minute)
                        set(Calendar.SECOND, 0)
                        set(Calendar.MILLISECOND, 0)
                    }
                    deadline = newCal.timeInMillis
                    showTimePicker = false
                }) { Text("确定", color = BrandGreen) }
            },
        )
    }
}

private fun formatDeadline(timestamp: Long): String {
    val nowCal = Calendar.getInstance()
    val targetCal = Calendar.getInstance().apply { timeInMillis = timestamp }
    val time = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(timestamp))
    val dayDiff = ((startOfDay(targetCal) - startOfDay(nowCal)) / 86_400_000L).toInt()
    return when {
        dayDiff == 0 -> "今天 $time"
        dayDiff == 1 -> "明天 $time"
        dayDiff == -1 -> "昨天 $time"
        targetCal.get(Calendar.YEAR) == nowCal.get(Calendar.YEAR) ->
            "${targetCal.get(Calendar.MONTH) + 1}月${targetCal.get(Calendar.DAY_OF_MONTH)}日 $time"
        else ->
            "${targetCal.get(Calendar.YEAR)}年${targetCal.get(Calendar.MONTH) + 1}月${targetCal.get(Calendar.DAY_OF_MONTH)}日 $time"
    }
}

private fun startOfDay(cal: Calendar): Long =
    (cal.clone() as Calendar).apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis
