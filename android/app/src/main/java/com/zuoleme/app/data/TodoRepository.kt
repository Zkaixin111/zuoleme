package com.zuoleme.app.data

import android.content.Context
import androidx.room.Room
import com.zuoleme.app.reminder.AlarmScheduler
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * 待办仓库：所有写操作都在落库后同步维护本地闹钟，
 * 保证「数据是什么样，提醒就是什么样」，不需要服务器参与。
 */
class TodoRepository private constructor(context: Context) {
    private val db = Room.databaseBuilder(
        context.applicationContext,
        AppDatabase::class.java,
        "zuoleme.db",
    ).build()

    private val dao = db.todoDao()
    private val scheduler = AlarmScheduler(context.applicationContext)

    fun observeTodos(): Flow<List<TodoEntity>> = dao.observeAll()

    fun observeNearestPending(): Flow<TodoEntity?> = dao.observeNearestPending()

    suspend fun nearestPending(): TodoEntity? = dao.nearestPending()

    suspend fun findById(id: String): TodoEntity? = dao.findById(id)

    suspend fun create(title: String, deadline: Long): TodoEntity {
        val now = System.currentTimeMillis()
        val todo = TodoEntity(
            id = UUID.randomUUID().toString(),
            title = title,
            deadline = deadline,
            done = false,
            createdAt = now,
            updatedAt = now,
        )
        dao.insert(todo)
        scheduler.scheduleAll(todo)
        return todo
    }

    /** 编辑标题/截止时间：重排该待办全部未触发档位 */
    suspend fun updateFields(id: String, title: String, deadline: Long) {
        val existing = dao.findById(id) ?: return
        val updated = existing.copy(title = title, deadline = deadline, updatedAt = System.currentTimeMillis())
        dao.update(updated)
        if (!updated.done) {
            scheduler.scheduleAll(updated)
        } else {
            scheduler.cancelAll(updated.id)
        }
    }

    suspend fun setDone(id: String, done: Boolean) {
        val existing = dao.findById(id) ?: return
        val updated = existing.copy(done = done, updatedAt = System.currentTimeMillis())
        dao.update(updated)
        if (done) {
            scheduler.cancelAll(id)
        } else {
            // 取消完成要重建提醒，否则误触一次「完成」就永久不再提醒
            scheduler.scheduleAll(updated)
        }
    }

    suspend fun delete(id: String) {
        scheduler.cancelAll(id)
        dao.deleteById(id)
    }

    /** 开机/更新后恢复全部未完成待办的提醒（已过去的档位自动不补发） */
    suspend fun rescheduleAll() {
        val now = System.currentTimeMillis()
        dao.getAll().filter { !it.done && it.deadline > now }.forEach { scheduler.scheduleAll(it) }
    }

    companion object {
        @Volatile
        private var instance: TodoRepository? = null

        fun get(context: Context): TodoRepository =
            instance ?: synchronized(this) {
                instance ?: TodoRepository(context).also { instance = it }
            }
    }
}
