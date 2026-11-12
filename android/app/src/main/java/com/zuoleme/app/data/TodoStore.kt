package com.zuoleme.app.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/** 本地待办（Room）。第一期纯本地存储，不依赖服务器与网络。 */
@Entity(tableName = "todos")
data class TodoEntity(
    @PrimaryKey val id: String,
    val title: String,
    /** 截止时间，毫秒时间戳 */
    val deadline: Long,
    val done: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
)

@Dao
interface TodoDao {
    /** 未完成在前、截止升序、创建时间兜底，与网页版排序一致 */
    @Query("SELECT * FROM todos ORDER BY done ASC, deadline ASC, createdAt ASC")
    fun observeAll(): Flow<List<TodoEntity>>

    @Query("SELECT * FROM todos ORDER BY done ASC, deadline ASC, createdAt ASC")
    suspend fun getAll(): List<TodoEntity>

    @Query("SELECT * FROM todos WHERE id = :id")
    suspend fun findById(id: String): TodoEntity?

    /** 最近一件未完成的事（常驻通知用） */
    @Query("SELECT * FROM todos WHERE done = 0 ORDER BY deadline ASC, createdAt ASC LIMIT 1")
    suspend fun nearestPending(): TodoEntity?

    @Query("SELECT * FROM todos WHERE done = 0 ORDER BY deadline ASC, createdAt ASC LIMIT 1")
    fun observeNearestPending(): Flow<TodoEntity?>

    @Insert
    suspend fun insert(todo: TodoEntity)

    @Update
    suspend fun update(todo: TodoEntity)

    @Query("DELETE FROM todos WHERE id = :id")
    suspend fun deleteById(id: String)
}

@Database(entities = [TodoEntity::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun todoDao(): TodoDao
}
